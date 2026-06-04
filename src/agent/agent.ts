import { streamText, stepCountIs, tool } from "ai"
import { z } from "zod"
import { provedor } from "../llm/openrouter"
import { modeloOllama, provedorOllama } from "../llm/ollama"
import {
  rotear,
  custoUSD,
  subirEsforco,
  deveReclassificarPraDiagnostico,
  registrarMastigado,
  mastigadoAnterior,
  MODELOS,
  CADEIA_DIAGNOSTICO,
  type Esforco,
} from "./router"
import { pareceSeguimento, type Modo } from "../engine/marques"
import { pareceMultiPasso, planejar, ferramentasDaFase, type Passo } from "./planner"
import { diagnosticarComFallback } from "./diagnostico"
import { escaladaPendente, estourouTeto, consumirEscalada } from "./recovery"
import { registrarTarefa } from "./custo"
import { ferramentas, novaRodada, rodar } from "../tools"
import { carregarContexto } from "../context/projeto"
import { carregarIndice } from "../conhecimento"
import {
  escopoDoDiagnostico,
  definirEscopo,
  escopoAtual,
  arquivosEditados,
  houveEdicao,
  candidatosForaEscopo,
  precisaTestGate,
  montarGate,
  comandosDoGate,
  INSTRUCAO_GATE_VERMELHO,
  trajetoriaLonga,
  INSTRUCAO_TRAJETORIA_LONGA,
  contornoAmbiente,
} from "./camada4"
import { ui } from "../terminal/ui"

type Msg = { role: "user" | "assistant"; content: string }

const MAX_ITERACOES = 24
const LIMITE_INVESTIGACAO = 8
const LIMITE_HISTORICO = 20

const SYSTEM_BASE = `Você é o Arara Code, um agente de engenharia de software brasileiro. Você opera no projeto do desenvolvedor com ferramentas para ler, editar e executar código.

Você tem dois modos de operação, e o sistema escolhe qual usar antes de cada tarefa:

MODO EXECUÇÃO (tarefas diretas):
Quando a tarefa diz claramente o que fazer, você executa com rapidez e precisão. Não delibere além do necessário. Leia o que precisa, aplique a mudança, verifique que funciona. Seja direto.

MODO DIAGNÓSTICO (tarefas de descoberta):
Quando a tarefa é um sintoma sem causa apontada, você investiga com método:
1. Mapeie todos os pontos do código que tocam no problema
2. Leia cada um — nunca assuma o conteúdo
3. Compare os caminhos que deveriam se comportar igual
4. Declare a causa raiz com evidência (arquivo:linha)
5. Verifique a hipótese relendo o código
6. Só então proponha a correção
Não pule para uma conclusão sem mapear e comparar primeiro.

REGRAS PERMANENTES (os dois modos):
- Responda sempre em português brasileiro, direto e técnico.
- SEMPRE leia os arquivos antes de afirmar como funcionam ou de editar.
- Ao citar um método ou classe, confirme que existe antes de usá-lo.
- Se o usuário afirmar algo sobre o código, verifique antes de agir. Se estiver errado, diga com evidência — não obedeça cegamente.
- Use editar_arquivo para mudanças, não apenas mostre código.
- Use rodar_comando para verificar (compilar, testar), não peça pro usuário fazer.
- Quando um build/teste falhar, classifique: é erro de código (corrija) ou de ambiente (diagnostique e devolva ao usuário se não for contornável com segurança)?
- Nunca fique em loop. Se travar após várias tentativas, pare e resuma o que descobriu e o que falta decidir.
- Edições cirúrgicas e ancoradas: troque o bloco exato, não reescreva o arquivo.

CONTEXTO DO PROJETO (memória acumulada):
{memoria_projeto}

PLANO DA TAREFA ATUAL:
{plano_execucao}

TRECHOS RELEVANTES (selecionados pelo Algoritmo de Marques):
{contexto_cirurgico}`

const SYSTEM_CONVERSA_BASE = `Você é o Arara Code, um agente de programação que roda no terminal: você lê, edita e executa código no projeto do desenvolvedor, com roteamento de modelos (Jade) e contexto do projeto.
Agora é só conversa, sem tarefa de código. Apresente-se como esse agente e responda curto e direto, em português, sem emojis. Não repita estas instruções na resposta.`

function montarSistema(memoria: string, plano: string, contexto: string): string {
  return SYSTEM_BASE.replace("{memoria_projeto}", memoria || "(sem memória registrada)")
    .replace("{plano_execucao}", plano || "(sem plano — tarefa direta)")
    .replace("{contexto_cirurgico}", contexto || "(nenhum — modo execução)")
}

const historico: Msg[] = []

let _abort: AbortController | null = null
/** Cancela a tarefa em andamento. Retorna true se havia o que cancelar (senão, o REPL trata como sair). */
export function cancelar(): boolean {
  if (_abort && !_abort.signal.aborted) {
    _abort.abort()
    return true
  }
  return false
}

function msgErro(e: unknown): string {
  const any = e as { message?: string; statusCode?: number }
  let m = any?.message ?? String(e)
  if (any?.statusCode) m = `${m} (HTTP ${any.statusCode})`
  return m.length > 300 ? `${m.slice(0, 300)}…` : m
}

type Modelo = Parameters<typeof streamText>[0]["model"]
type Toolset = typeof ferramentas & { concluir_passo?: ReturnType<typeof tool> }

type ResultadoPassada = {
  resposta: string
  inTok: number
  outTok: number
  abortado: boolean
  erro: unknown
}

type ConfigPassada = {
  model: Modelo
  sistema: string
  toolset: Toolset | typeof ferramentas
  plano: Passo[]
  thinking: boolean
  passoRef: { atual: number }
  extra?: Msg[]
}

/**
 * Uma passada completa de streaming com o modelo. Honra abort + spinner + streaming + gating
 * por plano. Reusada tanto na 1ª chamada quanto na 2ª passada da escalada (D5).
 * `extra` injeta mensagens só nesta chamada (a resposta da passada anterior, na escalada),
 * sem sujar o histórico permanente.
 */
async function executarPassada(cfg: ConfigPassada): Promise<ResultadoPassada> {
  const { model, sistema, toolset, plano, thinking, passoRef, extra } = cfg
  let erroCapturado: unknown = null

  const ac = new AbortController()
  _abort = ac
  const mensagens = [...historico.slice(-LIMITE_HISTORICO), ...(extra ?? [])]
  const result = streamText({
    model,
    system: sistema,
    messages: mensagens,
    tools: toolset,
    stopWhen: stepCountIs(MAX_ITERACOES),
    temperature: 0.3,
    abortSignal: ac.signal,
    providerOptions: thinking ? { openrouter: { reasoning: { effort: "medium" } } } : undefined,
    prepareStep: ({ stepNumber }) => {
      // 4.3-coerência: reinjeta escopo permitido + arquivos já editados em TODA passada, pra o
      // modelo não esquecer o alvo nem derivar pra fora ao longo de um loop comprido.
      const sis = sistema + notaEscopo()
      // Alarme de trajetória longa: passou do teto de passos sem fechar. Para de empilhar, manda
      // resumir e devolver — não roda até o teto cego (MAX_ITERACOES).
      if (trajetoriaLonga(stepNumber, false)) {
        return {
          activeTools: ["ler_arquivo", "editar_arquivo"] as (keyof typeof toolset)[],
          system: `${sis}\n\n${INSTRUCAO_TRAJETORIA_LONGA}`,
        }
      }
      if (plano.length) {
        if (passoRef.atual >= plano.length) return { system: sis }
        const p = plano[passoRef.atual]
        const checklist = plano
          .map((s, i) => `${i < passoRef.atual ? "[x]" : i === passoRef.atual ? "[>]" : "[ ]"} ${i + 1}. ${s.texto}`)
          .join("\n")
        const ativas = [...ferramentasDaFase(p.fase), "concluir_passo"]
        return {
          activeTools: ativas as (keyof typeof toolset)[],
          system: `${sis}\n\nPLANO (siga na ordem, não pule passos):\n${checklist}\n\nVocê está no passo ${passoRef.atual + 1}/${plano.length}: ${p.texto}. Faça SOMENTE esse passo agora. Ao terminar, chame concluir_passo.`,
        }
      }
      if (stepNumber >= LIMITE_INVESTIGACAO) {
        return {
          activeTools: ["ler_arquivo", "editar_arquivo"] as (keyof typeof toolset)[],
          system: `${sis}\n\nVocê já investigou ${stepNumber} passos — chega. PARE de buscar e de abrir arquivo novo. Responda AGORA: causa raiz com arquivo:linha + o trecho, e o conserto. Se for corrigir, edite. Não explore mais.`,
        }
      }
      return { system: sis }
    },
    onStepFinish: () => {
      ui.spinnerStart("Jade trabalhando")
    },
    onError: ({ error }) => {
      erroCapturado = error
    },
  })

  const tty = Boolean(process.stdout.isTTY)
  ui.spinnerStart(thinking ? "Jade raciocinando" : "Jade pensando")
  let resposta = ""
  let comecou = false
  try {
    for await (const delta of result.textStream) {
      resposta += delta
      if (tty) {
        if (!comecou) {
          ui.spinnerStop()
          ui.linhaBranca()
          comecou = true
        }
        ui.streamAppend(delta)
      }
    }
  } catch (e) {
    if (!ac.signal.aborted) erroCapturado = e
  }
  ui.spinnerStop()
  const abortado = ac.signal.aborted
  _abort = null

  let inTok = 0
  let outTok = 0
  try {
    const u = (await result.usage) as {
      inputTokens?: number
      outputTokens?: number
      promptTokens?: number
      completionTokens?: number
    }
    inTok = u?.inputTokens ?? u?.promptTokens ?? 0
    outTok = u?.outputTokens ?? u?.completionTokens ?? 0
  } catch {}

  return { resposta, inTok, outTok, abortado, erro: erroCapturado }
}

function fazerConcluirPasso(plano: Passo[], passoRef: { atual: number }) {
  return tool({
    description:
      "Marca o passo atual do plano como concluído e avança para o próximo. " +
      "Chame APENAS quando o passo atual estiver de fato terminado.",
    inputSchema: z.object({ resumo: z.string().describe("o que foi feito nesse passo") }),
    execute: async ({ resumo }) => {
      const feito = plano[passoRef.atual]?.texto ?? ""
      passoRef.atual++
      ui.passoConcluido(resumo ? `${feito} — ${resumo}` : feito)
      return passoRef.atual >= plano.length
        ? "Plano concluído. Finalize com um resumo curto ao usuário."
        : `Próximo passo (${passoRef.atual + 1}/${plano.length}): ${plano[passoRef.atual].texto}`
    },
  })
}

/** A última resposta do agente fez uma verificação que falhou? Gatilho pra avaliar escalada. */
function ultimaVerificouEFalhou(resposta: string): boolean {
  return /exit\s+[1-9]/.test(resposta) || /falh|erro de compila|build failed|test.*fail/i.test(resposta)
}

/**
 * 4.1 — Roda o portão de build do subprojeto tocado (comando vindo do project.json da Camada 1).
 * Aplica contorno de ambiente (Java incompatível) UMA vez se o build cuspir esse erro. Devolve
 * true (verde), false (vermelho) ou null (sem build determinável — não há portão a aplicar, aceita).
 */
type ResultadoGate =
  | { estado: "sem-gate" }
  | { estado: "verde" }
  | { estado: "vermelho" }
  | { estado: "ambiente"; mensagem: string }

async function rodarTestGate(): Promise<ResultadoGate> {
  const editados = arquivosEditados()
  if (!editados.length) return { estado: "sem-gate" }
  const indice = await carregarIndice(process.cwd())
  if (!indice) return { estado: "sem-gate" }
  const gate = montarGate(indice.project, editados[0])
  if (!gate) return { estado: "sem-gate" }
  ui.aviso(`portão: rodando build de ${gate.subprojeto}`)
  for (const cmd of comandosDoGate(gate)) {
    const { code, saida } = await rodar(cmd, (l) => ui.linhaComando(l.slice(0, 200)))
    if (code === 0) continue
    const amb = contornoAmbiente(cmd, saida)
    if (amb?.reexecutar) {
      ui.linhaComando("portão: runtime incompatível — tentando contorno…")
      const r2 = await rodar(amb.reexecutar, (l) => ui.linhaComando(l.slice(0, 200)))
      if (r2.code === 0) continue
      return { estado: "ambiente", mensagem: amb.mensagem }
    }
    if (amb) return { estado: "ambiente", mensagem: amb.mensagem }
    return { estado: "vermelho" }
  }
  return { estado: "verde" }
}

/**
 * Nota de escopo/edições reinjetada no system a cada passo (4.3-coerência). Lembra o modelo de quais
 * arquivos pode tocar (e de NÃO derivar) e o que já editou. Vazia quando o escopo é livre e nada foi
 * editado — não polui execução autônoma sem alvo definido.
 */
function notaEscopo(): string {
  const escopo = escopoAtual()
  const editados = arquivosEditados()
  const partes: string[] = []
  if (!escopo.livre) {
    partes.push(
      `ESCOPO PERMITIDO (só edite estes; outros pontos com o mesmo padrão podem ser intencionais — não derive): ${[...escopo.arquivos].join(", ")}.`,
    )
  }
  if (editados.length) partes.push(`JÁ EDITADO nesta tarefa: ${editados.join(", ")}.`)
  return partes.length ? `\n\n${partes.join("\n")}` : ""
}

type FaseDiagnostico =
  | { ok: true; tarefa: string; texto: string; modelos: string[]; tokens: number; custoUSD: number; ms: number }
  | { ok: false; motivo: "abortado" }
  | { ok: false; motivo: "erro"; erro: unknown }
  | { ok: false; motivo: "naoCravou"; texto: string; modelos: string[]; tokens: number; custoUSD: number; ms: number }

/**
 * Fase 1 do pipeline de diagnóstico (M3): UMA passada de raciocínio sobre o material já reunido,
 * com a cadeia de fallback INVISÍVEL (Gemini -> GPT-5.5 -> Opus). Se cravar, define o escopo (4.3) e
 * devolve a tarefa mastigada pra Fase 2 executar. Usada pelo modo diagnóstico E pela reclassificação
 * dinâmica (3.5). O usuário só vê "Jade raciocinando".
 */
async function diagnosticarEMastigar(
  input: string,
  openrouter: (slug: string) => Modelo,
): Promise<FaseDiagnostico> {
  const acR = new AbortController()
  _abort = acR
  const inicio = Date.now()
  ui.spinnerStart("Jade raciocinando")
  let diag: Awaited<ReturnType<typeof diagnosticarComFallback>>
  try {
    diag = await diagnosticarComFallback(
      input,
      [...CADEIA_DIAGNOSTICO],
      (slug) => openrouter(slug) as Modelo,
      custoUSD,
      () => {},
      (slug) => logInterno(`diagnostico marcha=${slug}`),
      acR.signal,
    )
  } catch (e) {
    ui.spinnerStop()
    _abort = null
    if (acR.signal.aborted) return { ok: false, motivo: "abortado" }
    return { ok: false, motivo: "erro", erro: e }
  }
  ui.spinnerStop()
  _abort = null
  if (acR.signal.aborted) return { ok: false, motivo: "abortado" }
  const tokens = diag.inTok + diag.outTok
  ui.linhaBranca()
  ui.resposta(diag.texto)
  ui.linhaBranca()
  if (!diag.cravou) {
    return { ok: false, motivo: "naoCravou", texto: diag.texto, modelos: diag.modelosUsados, tokens, custoUSD: diag.custoUSD, ms: Date.now() - inicio }
  }
  logInterno(`diagnostico cravou modelo=${diag.modelo} rodadas=${diag.rodadas}`)
  definirEscopo(escopoDoDiagnostico(diag.texto))
  logInterno(`escopo=[${[...escopoAtual().arquivos].join(", ")}]`)
  const tarefa = `A causa já foi diagnosticada abaixo. Aplique a correção SOMENTE nos arquivos citados na causa: leia o arquivo citado, faça a edição exata com editar_arquivo e rode o build pra verificar. NÃO gaste ações conferindo imports, assinaturas ou se uma classe/método existe — o build verifica isso; vá direto edição -> build. NÃO mude outros pontos com o mesmo padrão (podem ser intencionais). NÃO repita estas instruções na tua resposta; aja sobre elas. Se já estiver correto, confirme.\n\n${diag.texto}`
  return { ok: true, tarefa, texto: diag.texto, modelos: diag.modelosUsados, tokens, custoUSD: diag.custoUSD, ms: Date.now() - inicio }
}

export async function processar(input: string) {
  novaRodada()
  const ctx = await carregarContexto()

  // 3.0 herança de contexto: seguimento curto depois de um diagnóstico que cravou aplica AQUELE
  // diagnóstico (execução guiada sobre o mastigado guardado), em vez de re-rotear input vazio.
  const heranca = pareceSeguimento(input) && Boolean(mastigadoAnterior())
  const decisao = heranca
    ? { modo: "execucao" as Modo, thinking: false, modelo: MODELOS.execucao, motivo: "heranca-diagnostico" }
    : rotear(input)
  const { modo, thinking } = decisao
  let modoFinal: Modo = modo
  const conversa = modo === "conversa"
  logInterno(`rota motivo=${decisao.motivo} modo=${modo}`)

  // Conversa roda local e grátis no Ollama, quando disponível.
  if (conversa) {
    await processarConversa(input, ctx, decisao.modelo)
    return
  }

  let openrouter
  try {
    openrouter = provedor()
  } catch (e) {
    ui.jade(rotuloModo(modo))
    ui.erro((e as Error).message)
    return
  }

  ui.jade(rotuloModo(modo))

  // Pipeline de 2 fases. Diagnóstico raciocina UMA vez (caro, fora do loop) e entrega a correção
  // mastigada pro modelo rápido executar — mata a latência do loop com thinking em cada passo.
  let plano: Passo[] = []
  const contextoCirurgico = ""
  let tarefa = input
  let modeloExec = decisao.modelo
  let thinkingExec = thinking
  let tokensRaciocinio = 0
  let custoRaciocinio = 0
  let modelosDiag: string[] = []

  if (modo === "diagnostico") {
    const d = await diagnosticarEMastigar(input, openrouter)
    if (!d.ok) {
      if (d.motivo === "abortado") {
        finalizarAbort()
        return
      }
      if (d.motivo === "erro") {
        ui.erro(msgErro(d.erro))
        return
      }
      // naoCravou — NÃO manda lixo pra execução. Falha honesta ao usuário.
      ui.aviso("não cravei a causa com confiança.")
      ui.subItem("me aponta a direção (ex: 'olha no AraraPhoneNumberService') que eu vou direto.")
      ui.metricas(d.tokens, d.custoUSD, d.ms)
      await registrarTarefa({
        modo,
        modelo: d.modelos.join("→") || MODELOS.diagnostico,
        thinking: true,
        tokens: d.tokens,
        custoUSD: d.custoUSD,
        ms: d.ms,
      })
      return
    }
    tarefa = d.tarefa
    modelosDiag = d.modelos
    tokensRaciocinio = d.tokens
    custoRaciocinio = d.custoUSD
    modeloExec = MODELOS.execucao
    thinkingExec = false
    registrarMastigado(d.tarefa)
  } else if (heranca) {
    // 3.0 — aplica o diagnóstico anterior: o mastigado guardado vira a tarefa, com o ajuste do
    // usuário anexado. Escopo herdado do diagnóstico. Consome (não re-aplica no próximo seguimento).
    const anterior = mastigadoAnterior() as string
    tarefa = `${anterior}\n\nAjuste pedido pelo usuário agora: ${input}`
    definirEscopo(escopoDoDiagnostico(anterior))
    registrarMastigado(null)
  } else {
    if (pareceMultiPasso(input)) {
      ui.spinnerStart("Planejando")
      plano = await planejar(input)
      ui.spinnerStop()
      if (plano.length) ui.plano(plano.map((p) => p.texto))
    }
    // 4.3-ESCOPO em execução GUIADA: o escopo são os arquivos que o usuário citou no pedido. Sem
    // citação => modo livre (escopoDoDiagnostico sem arquivo é livre), autonomia geral preservada.
    definirEscopo(escopoDoDiagnostico(input))
  }

  const passoRef = { atual: 0 }
  const sistema = montarSistema(ctx.completo, plano.map((p, i) => `${i + 1}. ${p.texto}`).join("\n"), contextoCirurgico)
  const toolset: Toolset = plano.length
    ? { ...ferramentas, concluir_passo: fazerConcluirPasso(plano, passoRef) }
    : ferramentas

  historico.push({ role: "user", content: tarefa })
  const inicio = Date.now()

  let modeloAtual = modeloExec
  let totalIn = 0
  let totalOut = 0
  let respostaFinal = ""

  const r1 = await executarPassada({
    model: openrouter(modeloAtual) as Modelo,
    sistema,
    toolset,
    plano,
    thinking: thinkingExec,
    passoRef,
  })
  totalIn += r1.inTok
  totalOut += r1.outTok
  respostaFinal = r1.resposta

  if (r1.abortado) {
    finalizarAbort()
    return
  }
  if (r1.erro) {
    ui.erro(msgErro(r1.erro))
    historico.pop()
    return
  }

  // 3.5 — reclassificação dinâmica: uma execução que NÃO editou nada e devolveu hedge era, na real,
  // um diagnóstico disfarçado. Pivota pro pipeline de diagnóstico (sem recomeçar) e executa o
  // mastigado. Se nem assim cravar, mantém a resposta honesta original.
  if (deveReclassificarPraDiagnostico(modo, houveEdicao(), respostaFinal)) {
    modoFinal = "diagnostico"
    logInterno("reclassificacao execucao->diagnostico")
    const d = await diagnosticarEMastigar(input, openrouter)
    if (d.ok) {
      tokensRaciocinio += d.tokens
      custoRaciocinio += d.custoUSD
      modelosDiag = d.modelos
      registrarMastigado(d.tarefa)
      const rRe = await executarPassada({
        model: openrouter(MODELOS.execucao) as Modelo,
        sistema,
        toolset,
        plano,
        thinking: false,
        passoRef,
        extra: [{ role: "user" as const, content: d.tarefa }],
      })
      totalIn += rRe.inTok
      totalOut += rRe.outTok
      if (rRe.resposta.trim()) respostaFinal = rRe.resposta
      if (rRe.abortado) {
        finalizarAbort()
        return
      }
      if (rRe.erro) {
        ui.erro(msgErro(rRe.erro))
        historico.pop()
        return
      }
    } else if (d.motivo === "abortado") {
      finalizarAbort()
      return
    } else if (d.motivo === "erro") {
      ui.erro(msgErro(d.erro))
      return
    }
  }

  // Escalada por test-time compute (3.4): só quando a verificação ainda está vermelha E o tracker
  // marcou escalada pendente (3 erros de código no mesmo ponto). subirEsforco gradua: primeiro mais
  // thinking no MESMO modelo (barato), só depois troca de marcha. Invisível pro usuário (fachada Jade).
  let esforco: Esforco = { modelo: modeloAtual, thinking: thinkingExec }
  while (escaladaPendente() && !estourouTeto() && ultimaVerificouEFalhou(respostaFinal)) {
    const proximo = subirEsforco(esforco)
    if (!proximo) break
    esforco = proximo
    modeloAtual = esforco.modelo
    consumirEscalada()
    logInterno(`test-time-compute -> modelo=${esforco.modelo} thinking=${esforco.thinking}`)

    const rEsc = await executarPassada({
      model: openrouter(modeloAtual) as Modelo,
      sistema,
      toolset,
      plano,
      thinking: esforco.thinking,
      passoRef,
      extra: respostaFinal.trim() ? [{ role: "assistant", content: respostaFinal }] : undefined,
    })
    totalIn += rEsc.inTok
    totalOut += rEsc.outTok
    if (rEsc.resposta.trim()) respostaFinal = rEsc.resposta

    if (rEsc.abortado) {
      finalizarAbort()
      return
    }
    if (rEsc.erro) {
      ui.erro(msgErro(rEsc.erro))
      historico.pop()
      return
    }
  }

  // 4.1 TEST-GATE + 4.3-coerência (trajetória longa): se a tarefa editou código, o build do
  // subprojeto tocado PRECISA passar antes de aceitar. Vermelho => UMA passada de conserto guiada
  // (com instrução de só consertar, nada de edit novo). Determinístico: não depende do modelo lembrar.
  if (precisaTestGate(houveEdicao())) {
    const g = await rodarTestGate()
    if (g.estado === "ambiente") {
      respostaFinal = `${respostaFinal}\n\n[Jade] ${g.mensagem}`
    } else if (g.estado === "vermelho") {
      ui.aviso("build vermelho após a edição — consertando antes de fechar.")
      const rGate = await executarPassada({
        model: openrouter(modeloAtual) as Modelo,
        sistema,
        toolset,
        plano,
        thinking: true,
        passoRef,
        extra: [
          ...(respostaFinal.trim() ? [{ role: "assistant" as const, content: respostaFinal }] : []),
          { role: "user" as const, content: INSTRUCAO_GATE_VERMELHO },
        ],
      })
      totalIn += rGate.inTok
      totalOut += rGate.outTok
      if (rGate.resposta.trim()) respostaFinal = rGate.resposta
      if (rGate.abortado) {
        finalizarAbort()
        return
      }
      if (rGate.erro) {
        ui.erro(msgErro(rGate.erro))
        historico.pop()
        return
      }
      const g2 = await rodarTestGate()
      if (g2.estado === "vermelho") {
        respostaFinal = `${respostaFinal}\n\n[Jade] o build ainda não está verde — não declaro pronto. ${INSTRUCAO_TRAJETORIA_LONGA}`
      } else if (g2.estado === "ambiente") {
        respostaFinal = `${respostaFinal}\n\n[Jade] ${g2.mensagem}`
      }
    }
  }

  // Trava de escopo (4.3): se o modelo tentou tocar pontos parecidos fora do escopo, não some com
  // isso — fecha a rodada LISTANDO os candidatos e perguntando, em vez de corrigir por conta.
  const candidatos = candidatosForaEscopo()
  if (candidatos.length) {
    respostaFinal =
      `${respostaFinal}\n\n[Jade] Achei outros pontos com padrão parecido que NÃO toquei ` +
      `(cada um pode ter semântica diferente): ${candidatos.join(", ")}. Quer que eu corrija algum desses também?`
  }

  const tty = Boolean(process.stdout.isTTY)
  if (respostaFinal.trim()) {
    if (tty) ui.streamCommit()
    else {
      ui.linhaBranca()
      ui.resposta(respostaFinal)
    }
  }
  ui.linhaBranca()

  const custo = custoUSD(modeloAtual, totalIn, totalOut) + custoRaciocinio
  const tokens = totalIn + totalOut + tokensRaciocinio
  const houveThinking = thinkingExec || esforco.thinking || modoFinal === "diagnostico"
  // Fachada Jade: a tela mostra só tokens/custo/tempo. O modelo REAL fica no log interno (custo.json).
  ui.metricas(tokens, custo, Date.now() - inicio)
  const modeloInterno =
    modoFinal === "diagnostico"
      ? `${modelosDiag.join("→") || MODELOS.diagnostico}→${modeloAtual}`
      : modeloAtual
  await registrarTarefa({
    modo: modoFinal,
    modelo: modeloInterno,
    thinking: houveThinking,
    tokens,
    custoUSD: custo,
    ms: Date.now() - inicio,
  })
  historico.push({ role: "assistant", content: respostaFinal })
}

async function processarConversa(input: string, ctx: { resumo: string }, modeloCloud: string) {
  const sistema = `${SYSTEM_CONVERSA_BASE}\nProjeto atual: ${ctx.resumo}`
  let model: Modelo | null = null
  let modeloNome = modeloCloud
  let local = false

  const mOllama = await modeloOllama()
  if (mOllama) {
    model = provedorOllama()(mOllama) as Modelo
    modeloNome = `ollama:${mOllama}`
    local = true
  }
  if (!model) {
    try {
      model = provedor()(modeloCloud) as Modelo
    } catch (e) {
      ui.jade("conversa")
      ui.erro((e as Error).message)
      return
    }
  }

  ui.jade("conversa")
  logInterno(`conversa modelo=${modeloNome}`)
  historico.push({ role: "user", content: input })
  const inicio = Date.now()

  const ac = new AbortController()
  _abort = ac
  let erroCapturado: unknown = null
  const result = streamText({
    model,
    system: sistema,
    messages: historico.slice(-LIMITE_HISTORICO),
    stopWhen: stepCountIs(1),
    temperature: 0.3,
    abortSignal: ac.signal,
    onError: ({ error }) => {
      erroCapturado = error
    },
  })

  const tty = Boolean(process.stdout.isTTY)
  ui.spinnerStart("Jade pensando")
  let resposta = ""
  let comecou = false
  try {
    for await (const delta of result.textStream) {
      resposta += delta
      if (tty) {
        if (!comecou) {
          ui.spinnerStop()
          ui.linhaBranca()
          comecou = true
        }
        ui.streamAppend(delta)
      }
    }
  } catch (e) {
    if (!ac.signal.aborted) erroCapturado = e
  }
  ui.spinnerStop()
  const abortado = ac.signal.aborted
  _abort = null

  if (abortado) {
    finalizarAbort()
    return
  }
  if (erroCapturado) {
    ui.erro(msgErro(erroCapturado))
    historico.pop()
    return
  }

  if (resposta.trim()) {
    if (tty) ui.streamCommit()
    else {
      ui.linhaBranca()
      ui.resposta(resposta)
    }
  }
  ui.linhaBranca()
  let inTok = 0
  let outTok = 0
  try {
    const u = (await result.usage) as { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number }
    inTok = u?.inputTokens ?? u?.promptTokens ?? 0
    outTok = u?.outputTokens ?? u?.completionTokens ?? 0
  } catch {}
  const custo = local ? 0 : custoUSD(modeloCloud, inTok, outTok)
  ui.metricas(inTok + outTok, custo, Date.now() - inicio)
  await registrarTarefa({ modo: "conversa", modelo: modeloNome, thinking: false, tokens: inTok + outTok, custoUSD: custo, ms: Date.now() - inicio })
  historico.push({ role: "assistant", content: resposta })
}

function finalizarAbort() {
  ui.linhaBranca()
  ui.aviso("cancelado")
  _abort = null
  historico.pop()
}

/** Rótulo da marcha pra fachada Jade: o usuário vê só o MODO, nunca o modelo nem a marcha N. */
function rotuloModo(modo: string): string {
  if (modo === "diagnostico") return "diagnóstico"
  if (modo === "conversa") return "conversa"
  return "execução"
}

/**
 * Log INTERNO (modelo real, marcha, escalada). NUNCA vai pro stdout — esse é a fachada Jade que o
 * usuário lê. Vai pra stderr só sob ARARA_DEBUG=1. A trilha definitiva do modelo real por tarefa
 * fica no custo.json (canal admin do /custo). Aqui é só o rastro de qual marcha rodou.
 */
function logInterno(msg: string): void {
  if (process.env.ARARA_DEBUG === "1") process.stderr.write(`[jade] ${msg}\n`)
}
