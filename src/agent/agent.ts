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
import { pareceSeguimento, pontuarDiff, type Modo } from "../engine/marques"
import { pareceMultiPasso, planejar, ferramentasDaFase, type Passo } from "./planner"
import { diagnosticarComFallback, reunirMaterial, gerarCandidatosDiagnostico } from "./diagnostico"
import { pareceConsertarBuild, aterrarPorBuild } from "./grounding"
import { ancorarAlvo, notaAncoragem, pareceBugDeSintoma, diagnosticoAncoraNoAlvo, montarRespostaForaDoAlvo, type AlvoAncorado } from "./alvo"
import { listarFontes } from "../conhecimento/walk"
import { registrarBaseline, baselineAtual, compararComBaseline, rotuloFalha } from "./baseline"
import { anexarImagens, type ParteImagem } from "./imagem"
import { selecionarPorVerificacao } from "./testtime"
import { montarMapaAmplo, superficieDeArquivos } from "./contexto"
import { criarResumirFn } from "../context/resumir"
import { Backup } from "../tools/backup"
import { escaladaPendente, estourouTeto, consumirEscalada, podeTrocarMarcha, registrarTrocaMarcha } from "./recovery"
import { registrarTarefa } from "./custo"
import { ferramentas, novaRodada, rodar } from "../tools"
import { carregarContexto } from "../context/projeto"
import { carregarIndice, registrarBug, montarRegistroBug, buscarPrecedente } from "../conhecimento"
import {
  escopoDoDiagnostico,
  escopoDeArquivos,
  definirEscopo,
  resetCamada4,
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
import {
  decompor,
  valeOrquestrar,
  promptDoSub,
  relatorioProgresso,
  type SubFeito,
} from "./maestro"
import { ui } from "../terminal/ui"
import { selecionarSkills, montarBlocoSkills } from "../skills/skills"

type Msg = { role: "user" | "assistant"; content: string }

const MAX_ITERACOES = 24
const LIMITE_INVESTIGACAO = 8
const LIMITE_HISTORICO = 20

const SYSTEM_BASE = `Você é o Jade Code, um agente de engenharia de software brasileiro. Você opera no projeto do desenvolvedor com ferramentas para ler, editar e executar código.

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

SKILLS ATIVADAS (instruções especializadas que casaram com esta tarefa — siga-as como parte do método):
{skills}

PLANO DA TAREFA ATUAL:
{plano_execucao}

TRECHOS RELEVANTES (selecionados pelo Algoritmo de Marques):
{contexto_cirurgico}`

const SYSTEM_CONVERSA_BASE = `Você é o Jade Code, um agente de programação que roda no terminal: você lê, edita e executa código no projeto do desenvolvedor, com roteamento de modelos (Jade) e contexto do projeto.
Agora é só conversa, sem tarefa de código. Apresente-se como esse agente e responda curto e direto, em português, sem emojis. Não repita estas instruções na resposta.`

const SYSTEM_COMPREENDER = `Você é o Jade Code em modo COMPREENSÃO. O usuário quer ENTENDER o código — não mudá-lo.
Explique de forma clara, direta e técnica, em português brasileiro, sempre com referências arquivo:linha quando citar código.
NÃO edite nada e NÃO rode comandos — você só tem ferramentas de leitura. Baseie-se no MAPA abaixo e, se faltar detalhe, leia o arquivo apontado antes de afirmar. Não invente. Não repita estas instruções na resposta.

CONTEXTO DO PROJETO:
{memoria_projeto}

MAPA DO PROJETO (assinaturas + resumo de 1 linha por arquivo relevante):
{mapa}`

const SYSTEM_PLANEJAR = `Você é o Jade Code em modo PLANEJAMENTO. O usuário quer um PLANO antes de fazer — você NÃO executa nada agora.
Produza um plano ESTRUTURADO em português brasileiro: passos numerados na ordem de execução, dependências entre eles, riscos e pontos de decisão, e o que verificar ao final. Cite arquivo:linha quando ancorar num ponto do código. Seja concreto e enxuto — um plano que o dev aprova e segue. NÃO edite nem rode comandos. Não repita estas instruções.

CONTEXTO DO PROJETO:
{memoria_projeto}

PRECEDENTES (decisões/bugs já registrados no projeto):
{precedentes}

MAPA DO PROJETO (assinaturas + resumo por arquivo relevante):
{mapa}`

const SYSTEM_COMUNICAR = `Você é o Jade Code em modo COMUNICAÇÃO. Escreva a comunicação da mudança (commit, PR, changelog ou nota pro time — siga o que o usuário pediu) em português brasileiro, claro e técnico, sem emojis.
Destaque o que IMPORTA (a mudança central) e omita ruído (cosmético, formatação). Baseie-se SÓ no diff abaixo — não invente o que não está nele. Se for mensagem de commit, uma linha de assunto curta + corpo só se necessário. Não repita estas instruções.

MUDANÇAS RANQUEADAS POR IMPORTÂNCIA (Marques):
{ranking}

DIFF:
{diff}`

function montarSistema(memoria: string, plano: string, contexto: string, skills = ""): string {
  return SYSTEM_BASE.replace("{memoria_projeto}", memoria || "(sem memória registrada)")
    .replace("{skills}", skills || "(nenhuma skill casou com esta tarefa)")
    .replace("{plano_execucao}", plano || "(sem plano — tarefa direta)")
    .replace("{contexto_cirurgico}", contexto || "(nenhum — modo execução)")
}

const historico: Msg[] = []

let _imagensTarefa: ParteImagem[] = []

export type GateFinal = "verde" | "vermelho" | "ambiente" | "sem-gate" | "pre-existente" | "indeterminado"
export type Desfecho = { resposta: string; gate: GateFinal }
let _desfecho: Desfecho | null = null
export function desfechoUltimaTarefa(): Desfecho | null {
  return _desfecho
}
function registrarDesfecho(resposta: string, gate: GateFinal): void {
  _desfecho = { resposta, gate }
}

let _abort: AbortController | null = null

export function cancelar(): boolean {
  if (_abort && !_abort.signal.aborted) {
    _abort.abort()
    return true
  }
  return false
}

function msgErro(e: unknown): string {
  const any = e as { message?: unknown; statusCode?: unknown }
  let m = typeof any?.message === "string" && any.message ? any.message : String(e)
  if (typeof any?.statusCode === "number" && any.statusCode > 0) m = `${m} (HTTP ${any.statusCode})`
  return m.length > 300 ? `${m.slice(0, 300)}…` : m
}

async function consumirStreamAoVivo(stream: AsyncIterable<string>, aoFalhar: (e: unknown) => void): Promise<string> {
  const tty = Boolean(process.stdout.isTTY)
  let resposta = ""
  let comecou = false
  try {
    for await (const delta of stream) {
      resposta += delta
      if (!tty) continue
      if (!comecou) {
        ui.spinnerStop()
        ui.linhaBranca()
        comecou = true
      }
      ui.streamAppend(delta)
    }
  } catch (e) {
    aoFalhar(e)
  }
  return resposta
}

async function extrairUso(usage: PromiseLike<unknown>): Promise<{ inTok: number; outTok: number }> {
  try {
    const u = (await usage) as {
      inputTokens?: number
      outputTokens?: number
      promptTokens?: number
      completionTokens?: number
    }
    return { inTok: u?.inputTokens ?? u?.promptTokens ?? 0, outTok: u?.outputTokens ?? u?.completionTokens ?? 0 }
  } catch {
    return { inTok: 0, outTok: 0 }
  }
}

type Modelo = Parameters<typeof streamText>[0]["model"]
type Toolset = typeof ferramentas & { concluir_passo?: ReturnType<typeof fazerConcluirPasso> }

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

async function executarPassada(cfg: ConfigPassada): Promise<ResultadoPassada> {
  const { model, sistema, toolset, plano, thinking, passoRef, extra } = cfg
  let erroCapturado: unknown = null

  const ac = new AbortController()
  _abort = ac
  const mensagens = anexarImagens([...historico.slice(-LIMITE_HISTORICO), ...(extra ?? [])], _imagensTarefa)
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

      const sis = sistema + notaEscopo()

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

  ui.spinnerStart(thinking ? "Jade raciocinando" : "Jade pensando")
  const resposta = await consumirStreamAoVivo(result.textStream, (e) => {
    if (!ac.signal.aborted) erroCapturado = e
  })
  ui.spinnerStop()
  const abortado = ac.signal.aborted
  _abort = null

  const { inTok, outTok } = await extrairUso(result.usage)
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

type ConsertoGate = {
  gate: ResultadoGate
  resposta: string
  inTok: number
  outTok: number
  abortado: boolean
  erro: unknown
}

async function rodarGateComConserto(
  cfg: Omit<ConfigPassada, "thinking" | "extra">,
  respostaAtual: string,
): Promise<ConsertoGate> {
  let gate = await rodarTestGate()
  if (gate.estado !== "vermelho") {
    return { gate, resposta: respostaAtual, inTok: 0, outTok: 0, abortado: false, erro: null }
  }
  ui.aviso("build vermelho após a edição — consertando antes de fechar.")
  const r = await executarPassada({
    ...cfg,
    thinking: true,
    extra: [
      ...(respostaAtual.trim() ? [{ role: "assistant" as const, content: respostaAtual }] : []),
      { role: "user" as const, content: INSTRUCAO_GATE_VERMELHO },
    ],
  })
  const resposta = r.resposta.trim() ? r.resposta : respostaAtual
  if (r.abortado || r.erro) {
    return { gate, resposta, inTok: r.inTok, outTok: r.outTok, abortado: r.abortado, erro: r.erro }
  }
  gate = await rodarTestGate()
  return { gate, resposta, inTok: r.inTok, outTok: r.outTok, abortado: false, erro: null }
}

function ultimaVerificouEFalhou(resposta: string): boolean {
  return /exit\s+[1-9]/.test(resposta) || /falh|erro de compila|build failed|test.*fail/i.test(resposta)
}

type ResultadoGate =
  | { estado: "sem-gate" }
  | { estado: "verde" }
  | { estado: "vermelho"; novas: string[] }
  | { estado: "pre-existente"; preExistentes: string[] }
  | { estado: "indeterminado"; naoAtribuiveis: string[] }
  | { estado: "ambiente"; mensagem: string }

function classificarVermelho(saida: string): ResultadoGate {
  const base = baselineAtual()
  if (!base) return { estado: "vermelho", novas: [] }
  const v = compararComBaseline(base, saida)
  if (v.tipo === "sem-piora") return { estado: "pre-existente", preExistentes: v.preExistentes.map(rotuloFalha) }
  if (v.tipo === "indeterminado") return { estado: "indeterminado", naoAtribuiveis: v.naoAtribuiveis.map(rotuloFalha) }
  return { estado: "vermelho", novas: v.novas.map(rotuloFalha) }
}

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
    return classificarVermelho(saida)
  }
  return { estado: "verde" }
}

function mapaGateFinal(gate: ResultadoGate): GateFinal {
  switch (gate.estado) {
    case "verde": return "verde"
    case "ambiente": return "ambiente"
    case "pre-existente": return "pre-existente"
    case "indeterminado": return "indeterminado"
    case "vermelho": return "vermelho"
    default: return "sem-gate"
  }
}

function sufixoGate(gate: ResultadoGate): string {
  if (gate.estado === "ambiente") return `\n\n[Jade] ${gate.mensagem}`
  if (gate.estado === "pre-existente")
    return (
      `\n\n[Jade] Consertei o que foi pedido. O build ainda não fecha verde, mas SÓ por falhas que ` +
      `JÁ existiam antes de eu tocar (fora do escopo): ${gate.preExistentes.join(", ")}. Não introduzi nenhuma.`
    )
  if (gate.estado === "indeterminado")
    return (
      `\n\n[Jade] Corrigi a compilação. Os testes agora rodam e estes falham: ${gate.naoAtribuiveis.join(", ")}. ` +
      `Como o projeto NÃO compilava antes da minha mudança, não dá pra afirmar se já falhavam — não os introduzi na compilação, mas confirma se são regressão ou dívida anterior.`
    )
  if (gate.estado === "vermelho")
    return `\n\n[Jade] o build não fechou verde${gate.novas.length ? ` — falhas novas que preciso resolver: ${gate.novas.join(", ")}` : ""}. Não declaro pronto.`
  return ""
}

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

  | { ok: false; motivo: "foraDoAlvo"; texto: string; foraDoAlvo: string[]; modelos: string[]; tokens: number; custoUSD: number; ms: number }

async function ancorarAlvoDoRepo(input: string): Promise<AlvoAncorado | null> {
  try {
    const fontes = await listarFontes(process.cwd())
    return ancorarAlvo(input, fontes.map((f) => f.caminho))
  } catch {
    return null
  }
}

async function lerTextoFonte(arquivo: string): Promise<string | null> {
  if (arquivo.startsWith("/")) return null
  try {
    const f = Bun.file(`${process.cwd()}/${arquivo}`)
    if (!(await f.exists())) return null
    return await f.text()
  } catch {
    return null
  }
}

async function diagnosticarEMastigar(
  input: string,
  openrouter: (slug: string) => Modelo,
  alvo: AlvoAncorado | null = null,
): Promise<FaseDiagnostico> {
  const acR = new AbortController()
  _abort = acR
  const inicio = Date.now()
  ui.spinnerStart("Jade raciocinando")
  let diag: Awaited<ReturnType<typeof diagnosticarComFallback>>
  try {
    diag = await diagnosticarComFallback(
      alvo ? `${input}${notaAncoragem(alvo)}` : input,
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

  if (alvo) {
    const veredito = await diagnosticoAncoraNoAlvo(alvo, diag.texto, lerTextoFonte)
    if (!veredito.ancorado) {
      logInterno(`diagnostico fora-do-alvo: cravou em [${veredito.foraDoAlvo.join(", ")}], alvo era [${alvo.arquivos.join(", ")}]`)
      return { ok: false, motivo: "foraDoAlvo", texto: diag.texto, foraDoAlvo: veredito.foraDoAlvo, modelos: diag.modelosUsados, tokens, custoUSD: diag.custoUSD, ms: Date.now() - inicio }
    }
  }

  const escopoDiag = escopoDoDiagnostico(diag.texto)
  definirEscopo(alvo ? escopoDeArquivos([...escopoDiag.arquivos, ...alvo.arquivos]) : escopoDiag)
  logInterno(`escopo=[${[...escopoAtual().arquivos].join(", ")}]`)
  const tarefa = `A causa já foi diagnosticada abaixo. Aplique a correção SOMENTE nos arquivos citados na causa: leia o arquivo citado, faça a edição exata com editar_arquivo e rode o build pra verificar. NÃO gaste ações conferindo imports, assinaturas ou se uma classe/método existe — o build verifica isso; vá direto edição -> build. NÃO mude outros pontos com o mesmo padrão (podem ser intencionais). NÃO repita estas instruções na tua resposta; aja sobre elas. Se já estiver correto, confirme.\n\n${diag.texto}`
  return { ok: true, tarefa, texto: diag.texto, modelos: diag.modelosUsados, tokens, custoUSD: diag.custoUSD, ms: Date.now() - inicio }
}

function ehComplexo(decisao: ReturnType<typeof rotear>): boolean {
  return decisao.modelo === MODELOS.loopLongo
}

const N_CANDIDATOS_TTC = 3

type ResultadoTTC = { ok: boolean; texto: string; tokens: number; custoUSD: number }

async function tentarTestTimeCompute(
  input: string,
  openrouter: ReturnType<typeof provedor>,
  ctx: { completo: string },
  skills = "",
): Promise<ResultadoTTC> {
  const acR = new AbortController()
  _abort = acR
  ui.spinnerStart("Jade raciocinando")
  let candidatos: Awaited<ReturnType<typeof gerarCandidatosDiagnostico>>
  try {
    const material = await reunirMaterial(input)
    if (!material.pares.length) {
      ui.spinnerStop()
      _abort = null
      return { ok: false, texto: "", tokens: 0, custoUSD: 0 }
    }
    candidatos = await gerarCandidatosDiagnostico(input, material, openrouter(MODELOS.diagnostico) as Modelo, N_CANDIDATOS_TTC, acR.signal)
  } catch {
    ui.spinnerStop()
    _abort = null
    return { ok: false, texto: "", tokens: 0, custoUSD: 0 }
  }
  ui.spinnerStop()
  _abort = null

  let tokens = 0
  let custo = 0
  for (const c of candidatos) {
    tokens += c.inTok + c.outTok
    custo += custoUSD(MODELOS.diagnostico, c.inTok, c.outTok)
  }
  if (!candidatos.length) return { ok: false, texto: "", tokens, custoUSD: custo }
  logInterno(`test-time-compute: ${candidatos.length} candidatos, selecionando por verificação`)

  const sistema = montarSistema(ctx.completo, "", "", skills)
  let marca = 0
  const sel = await selecionarPorVerificacao(
    candidatos.length,
    async (i) => candidatos[i],
    async (c) => {
      resetCamada4()
      definirEscopo(escopoDoDiagnostico(c.texto))
      marca = Backup.tamanho()
      const tarefaC = `A causa foi diagnosticada abaixo. Aplique a correção SOMENTE nos arquivos citados na causa: vá direto edição -> build. NÃO repita estas instruções; aja.\n\n${c.texto}`
      const r = await executarPassada({
        model: openrouter(MODELOS.execucao) as Modelo,
        sistema,
        toolset: ferramentas,
        plano: [],
        thinking: false,
        passoRef: { atual: 0 },
        extra: [{ role: "user" as const, content: tarefaC }],
      })
      tokens += r.inTok + r.outTok
      custo += custoUSD(MODELOS.execucao, r.inTok, r.outTok)
      if (r.abortado || r.erro) return false
      const g = await rodarTestGate()
      return g.estado === "verde"
    },
    async () => {
      await Backup.reverterAte(marca)
    },
  )
  return sel.vencedor
    ? { ok: true, texto: sel.vencedor.texto, tokens, custoUSD: custo }
    : { ok: false, texto: "", tokens, custoUSD: custo }
}

const CTX_TRECHO = 4

async function lerTrecho(arquivo: string, linha: number): Promise<string | null> {
  if (arquivo.startsWith("/")) return null
  try {
    const f = Bun.file(`${process.cwd()}/${arquivo}`)
    if (!(await f.exists())) return null
    const linhas = (await f.text()).split("\n")
    const ini = Math.max(0, linha - 1 - CTX_TRECHO)
    const fim = Math.min(linhas.length, linha + CTX_TRECHO)
    return linhas.slice(ini, fim).map((l, i) => `${ini + i + 1}\t${l}`).join("\n")
  } catch {
    return null
  }
}

async function consertarBuildAterrado(
  input: string,
  openrouter: ReturnType<typeof provedor>,
  ctx: { completo: string },
  skills = "",
): Promise<boolean> {
  if (!pareceConsertarBuild(input)) return false
  const indice = await carregarIndice(process.cwd())
  const comando = indice?.project.testCmd ?? indice?.project.buildCmd ?? null
  if (!comando) return false

  const inicio = Date.now()
  const acP = new AbortController()
  _abort = acP
  ui.spinnerStart("Jade rodando o build pra achar o erro")
  let at: Awaited<ReturnType<typeof aterrarPorBuild>>
  try {
    at = await aterrarPorBuild(input, {
      raiz: process.cwd(),
      comando,
      rodar: async (cmd) => {
        const r = await rodar(cmd, (l) => ui.linhaComando(l.slice(0, 200)), undefined, acP.signal)
        return { code: r.code, saida: r.saida }
      },
      lerTrecho,
    })
  } catch {
    ui.spinnerStop()
    _abort = null
    return false
  }
  ui.spinnerStop()
  _abort = null
  if (acP.signal.aborted) {
    finalizarAbort()
    return true
  }
  if (!at) return false

  if (at.tipo === "ja-verde") {
    const msg = "[Jade] rodei o build/teste do projeto e ele já está VERDE — não há nada a consertar."
    ui.linhaBranca()
    ui.resposta(msg)
    ui.linhaBranca()
    historico.push({ role: "user", content: input })
    historico.push({ role: "assistant", content: msg })
    registrarDesfecho(msg, "verde")
    ui.metricas(0, 0, Date.now() - inicio)
    await registrarTarefa({ modo: "execucao", modelo: "gate-only", thinking: false, tokens: 0, custoUSD: 0, ms: Date.now() - inicio })
    return true
  }

  registrarBaseline(at.saida)
  definirEscopo(escopoDeArquivos(at.arquivos))
  logInterno(`grounding-build: aterrado em [${at.arquivos.join(", ")}]`)
  ui.subItem(`erro apontado em: ${at.arquivos.join(", ")}`)
  const sistema = montarSistema(ctx.completo, "", "", skills)
  historico.push({ role: "user", content: input })

  let totalIn = 0
  let totalOut = 0
  let resposta = ""
  const r = await executarPassada({
    model: openrouter(MODELOS.execucao) as Modelo,
    sistema,
    toolset: ferramentas,
    plano: [],
    thinking: false,
    passoRef: { atual: 0 },
    extra: [{ role: "user" as const, content: at.tarefa }],
  })
  totalIn += r.inTok
  totalOut += r.outTok
  resposta = r.resposta
  if (r.abortado) {
    finalizarAbort()
    return true
  }
  if (r.erro) {
    ui.erro(msgErro(r.erro))
    historico.pop()
    return true
  }

  const conserto = await rodarGateComConserto(
    { model: openrouter(MODELOS.execucao) as Modelo, sistema, toolset: ferramentas, plano: [], passoRef: { atual: 0 } },
    resposta,
  )
  totalIn += conserto.inTok
  totalOut += conserto.outTok
  resposta = conserto.resposta
  if (conserto.abortado) {
    finalizarAbort()
    return true
  }

  const gateFinal = mapaGateFinal(conserto.gate)
  resposta += sufixoGate(conserto.gate)

  const tty = Boolean(process.stdout.isTTY)
  if (resposta.trim()) {
    if (tty) ui.streamCommit()
    else {
      ui.linhaBranca()
      ui.resposta(resposta)
    }
  }
  ui.linhaBranca()
  historico.push({ role: "assistant", content: resposta })
  registrarDesfecho(resposta, gateFinal)
  const custo = custoUSD(MODELOS.execucao, totalIn, totalOut)
  ui.metricas(totalIn + totalOut, custo, Date.now() - inicio)
  await registrarTarefa({
    modo: "execucao",
    modelo: `grounding→${MODELOS.execucao}`,
    thinking: false,
    tokens: totalIn + totalOut,
    custoUSD: custo,
    ms: Date.now() - inicio,
  })
  return true
}

async function orquestrarComplexo(
  input: string,
  openrouter: ReturnType<typeof provedor>,
  ctx: { completo: string; resumo: string },
  skills = "",
): Promise<boolean> {
  const inicio = Date.now()
  const acP = new AbortController()
  _abort = acP
  ui.spinnerStart("Jade planejando")
  const dec = await decompor(input, openrouter(MODELOS.diagnostico) as Modelo)
  ui.spinnerStop()
  _abort = null
  if (acP.signal.aborted) {
    finalizarAbort()
    return true
  }
  if (!dec || !valeOrquestrar(dec.plano)) return false

  const plano = dec.plano
  logInterno(`maestro decompôs em ${plano.subobjetivos.length} sub-objetivos`)
  ui.plano(plano.subobjetivos.map((s) => `${s.descricao}${s.arquivosAlvo.length ? ` (${s.arquivosAlvo.join(", ")})` : ""}`))

  let tokensTotal = dec.inTok + dec.outTok
  let custoTotal = custoUSD(MODELOS.diagnostico, dec.inTok, dec.outTok)
  const feitos: SubFeito[] = []
  const passoRef = { atual: 0 }
  const sistema = montarSistema(ctx.completo, "", "", skills)
  historico.push({ role: "user", content: input })

  const finalizar = (rel: string, gate: GateFinal) => {
    ui.linhaBranca()
    ui.resposta(rel)
    ui.linhaBranca()
    historico.push({ role: "assistant", content: rel })
    registrarDesfecho(rel, gate)
    ui.metricas(tokensTotal, custoTotal, Date.now() - inicio)
    return registrarTarefa({
      modo: "loop-longo",
      modelo: `${MODELOS.diagnostico}(plano)→${MODELOS.execucao}`,
      thinking: true,
      tokens: tokensTotal,
      custoUSD: custoTotal,
      ms: Date.now() - inicio,
    })
  }

  for (let i = 0; i < plano.subobjetivos.length; i++) {
    const sub = plano.subobjetivos[i]
    ui.jade(`sub-objetivo ${i + 1}/${plano.subobjetivos.length}`)
    definirEscopo(escopoDeArquivos(sub.arquivosAlvo))

    let tarefaSub = promptDoSub(plano, i)
    if (sub.tipo === "diagnostico") {
      const d = await diagnosticarEMastigar(sub.descricao, openrouter)
      if (d.ok) {
        tokensTotal += d.tokens
        custoTotal += d.custoUSD
        tarefaSub = `${tarefaSub}\n\nDIAGNÓSTICO:\n${d.tarefa}`
      } else if (d.motivo === "abortado") {
        finalizarAbort()
        return true
      }
    }

    const r = await executarPassada({
      model: openrouter(MODELOS.execucao) as Modelo,
      sistema,
      toolset: ferramentas,
      plano: [],
      thinking: false,
      passoRef,
      extra: [{ role: "user" as const, content: tarefaSub }],
    })
    tokensTotal += r.inTok + r.outTok
    custoTotal += custoUSD(MODELOS.execucao, r.inTok, r.outTok)
    if (r.abortado) {
      finalizarAbort()
      return true
    }
    if (r.erro) {
      await finalizar(relatorioProgresso(plano, feitos, i, msgErro(r.erro)), "sem-gate")
      return true
    }

    const conserto = await rodarGateComConserto(
      { model: openrouter(MODELOS.execucao) as Modelo, sistema, toolset: ferramentas, plano: [], passoRef },
      r.resposta,
    )
    tokensTotal += conserto.inTok + conserto.outTok
    custoTotal += custoUSD(MODELOS.execucao, conserto.inTok, conserto.outTok)
    if (conserto.abortado) {
      finalizarAbort()
      return true
    }
    const gate = conserto.gate

    if (gate.estado === "ambiente") {
      feitos.push({ descricao: sub.descricao, estado: "sem-gate" })
      await finalizar(relatorioProgresso(plano, feitos, i, gate.mensagem), "ambiente")
      return true
    }
    if (gate.estado === "vermelho") {
      feitos.push({ descricao: sub.descricao, estado: "travou" })
      await finalizar(relatorioProgresso(plano, feitos, i, "o build não fechou verde após o conserto"), "vermelho")
      return true
    }

    feitos.push({ descricao: sub.descricao, estado: gate.estado === "verde" ? "verde" : "sem-gate" })
    historico.push({ role: "assistant", content: `sub-objetivo ${i + 1} concluído: ${sub.descricao}` })
  }

  await finalizar(
    relatorioProgresso(plano, feitos, null, ""),
    feitos.length && feitos.every((f) => f.estado === "verde") ? "verde" : "sem-gate",
  )
  return true
}

type PrepDiagnostico =
  | { fim: true }
  | { fim: false; tarefa: string; diagTexto: string; modelos: string[]; tokens: number; custoUSD: number }

async function faseDiagnostico(
  input: string,
  openrouter: ReturnType<typeof provedor>,
  ctx: { completo: string },
  blocoSkills: string,
): Promise<PrepDiagnostico> {
  const alvo = await ancorarAlvoDoRepo(input)
  if (alvo) {
    ui.subItem(`alvo apontado: ${alvo.arquivos.join(", ")}`)
    logInterno(`alvo ancorado em [${alvo.arquivos.join(", ")}] por termos [${alvo.termos.join(", ")}]`)
  }
  const d = await diagnosticarEMastigar(input, openrouter, alvo)
  if (d.ok) {
    return { fim: false, tarefa: d.tarefa, diagTexto: d.texto, modelos: d.modelos, tokens: d.tokens, custoUSD: d.custoUSD }
  }
  if (d.motivo === "abortado") {
    finalizarAbort()
    return { fim: true }
  }
  if (d.motivo === "erro") {
    ui.erro(msgErro(d.erro))
    return { fim: true }
  }
  if (d.motivo === "foraDoAlvo" && alvo) {
    const resposta = montarRespostaForaDoAlvo(alvo, d.foraDoAlvo, d.texto)
    ui.linhaBranca()
    ui.resposta(resposta)
    ui.linhaBranca()
    historico.push({ role: "user", content: input })
    historico.push({ role: "assistant", content: resposta })
    registrarDesfecho(resposta, "sem-gate")
    ui.metricas(d.tokens, d.custoUSD, d.ms)
    await registrarTarefa({
      modo: "diagnostico",
      modelo: d.modelos.join("→") || MODELOS.diagnostico,
      thinking: true,
      tokens: d.tokens,
      custoUSD: d.custoUSD,
      ms: d.ms,
    })
    return { fim: true }
  }

  const ttc = await tentarTestTimeCompute(input, openrouter, ctx, blocoSkills)
  if (ttc.ok) {
    const respostaTTC = `Cravei por verificação: gerei ${N_CANDIDATOS_TTC} hipóteses em paralelo e apliquei a que fechou o build.\n\n${ttc.texto}`
    try {
      await registrarBug(process.cwd(), montarRegistroBug(input, ttc.texto, arquivosEditados()))
      logInterno("memoria: bug registrado (test-time-compute)")
    } catch {}
    ui.linhaBranca()
    ui.resposta(respostaTTC)
    ui.linhaBranca()
    ui.metricas(d.tokens + ttc.tokens, d.custoUSD + ttc.custoUSD, d.ms)
    await registrarTarefa({
      modo: "diagnostico",
      modelo: `${d.modelos.join("→") || MODELOS.diagnostico}+ttc`,
      thinking: true,
      tokens: d.tokens + ttc.tokens,
      custoUSD: d.custoUSD + ttc.custoUSD,
      ms: d.ms,
    })
    historico.push({ role: "user", content: input })
    historico.push({ role: "assistant", content: respostaTTC })
    registrarDesfecho(respostaTTC, "verde")
    return { fim: true }
  }

  ui.aviso("não cravei a causa com confiança.")
  ui.subItem("me aponta a direção (ex: 'olha no PaymentService') que eu vou direto.")
  registrarDesfecho(
    `${d.texto}\n\n[Jade] Não cravei a causa com confiança — não vou editar no escuro. Me aponta a direção (ex: 'olha no PaymentService') que eu vou direto.`,
    "sem-gate",
  )
  ui.metricas(d.tokens + ttc.tokens, d.custoUSD + ttc.custoUSD, d.ms)
  await registrarTarefa({
    modo: "diagnostico",
    modelo: d.modelos.join("→") || MODELOS.diagnostico,
    thinking: true,
    tokens: d.tokens + ttc.tokens,
    custoUSD: d.custoUSD + ttc.custoUSD,
    ms: d.ms,
  })
  return { fim: true }
}

async function prepararExecucaoGuiada(input: string): Promise<{ plano: Passo[]; tarefa: string }> {
  let plano: Passo[] = []
  if (pareceMultiPasso(input)) {
    ui.spinnerStart("Planejando")
    plano = await planejar(input)
    ui.spinnerStop()
    if (plano.length) ui.plano(plano.map((p) => p.texto))
  }

  const escopoInput = escopoDoDiagnostico(input)
  definirEscopo(escopoInput)

  let tarefa = input
  if (escopoInput.livre && pareceBugDeSintoma(input)) {
    const alvoExec = await ancorarAlvoDoRepo(input)
    if (alvoExec) {
      definirEscopo(escopoDeArquivos(alvoExec.arquivos))
      tarefa = `${input}${notaAncoragem(alvoExec)}`
      ui.subItem(`alvo apontado: ${alvoExec.arquivos.join(", ")}`)
      logInterno(`alvo ancorado (execucao) em [${alvoExec.arquivos.join(", ")}] por termos [${alvoExec.termos.join(", ")}]`)
    }
  }
  return { plano, tarefa }
}

async function fecharTarefa(f: {
  input: string
  inicio: number
  modoFinal: Modo
  gateFinal: GateFinal
  resposta: string
  diagTexto: string | null
  modelosDiag: string[]
  modeloAtual: string
  tokens: number
  custoUSD: number
  houveThinking: boolean
}): Promise<void> {
  let resposta = f.resposta
  if (f.gateFinal === "verde" && f.modoFinal === "diagnostico" && f.diagTexto) {
    try {
      await registrarBug(process.cwd(), montarRegistroBug(f.input, f.diagTexto, arquivosEditados()))
      logInterno("memoria: bug registrado")
    } catch (e) {
      logInterno(`memoria: falha ao registrar bug (${msgErro(e)})`)
    }
  }

  const candidatos = candidatosForaEscopo()
  if (candidatos.length) {
    resposta =
      `${resposta}\n\n[Jade] Achei outros pontos com padrão parecido que NÃO toquei ` +
      `(cada um pode ter semântica diferente): ${candidatos.join(", ")}. Quer que eu corrija algum desses também?`
  }

  const tty = Boolean(process.stdout.isTTY)
  if (resposta.trim()) {
    if (tty) ui.streamCommit()
    else {
      ui.linhaBranca()
      ui.resposta(resposta)
    }
  }
  ui.linhaBranca()

  ui.metricas(f.tokens, f.custoUSD, Date.now() - f.inicio)
  const modeloInterno =
    f.modoFinal === "diagnostico"
      ? `${f.modelosDiag.join("→") || MODELOS.diagnostico}→${f.modeloAtual}`
      : f.modeloAtual
  await registrarTarefa({
    modo: f.modoFinal,
    modelo: modeloInterno,
    thinking: f.houveThinking,
    tokens: f.tokens,
    custoUSD: f.custoUSD,
    ms: Date.now() - f.inicio,
  })
  historico.push({ role: "assistant", content: resposta })
  registrarDesfecho(resposta, f.gateFinal)
}

export async function processar(input: string, imagens: ParteImagem[] = []) {
  novaRodada()
  _desfecho = null
  _imagensTarefa = imagens
  const ctx = await carregarContexto()

  const indiceRota = await carregarIndice(process.cwd())

  const heranca = pareceSeguimento(input) && Boolean(mastigadoAnterior())
  const decisao = heranca
    ? { modo: "execucao" as Modo, thinking: false, modelo: MODELOS.execucao, motivo: "heranca-diagnostico" }
    : rotear(input, indiceRota ?? undefined)
  const { modo, thinking } = decisao
  let modoFinal: Modo = modo
  const conversa = modo === "conversa"
  logInterno(`rota motivo=${decisao.motivo} modo=${modo}`)

  if (decisao.pedirQuebra) {
    ui.jade(rotuloModo(modo))
    ui.aviso("essa tarefa junta várias intenções numa frase só.")
    ui.subItem("manda uma de cada vez (ex: primeiro 'diagnostica X', depois 'corrige Y') que eu trato cada uma com a marcha certa.")
    return
  }

  if (conversa) {
    await processarConversa(input, ctx, decisao.modelo)
    return
  }

  if (modo === "compreender") {
    await processarCompreender(input, ctx, decisao.modelo)
    return
  }
  if (modo === "planejar") {
    await processarPlanejar(input, ctx, decisao.modelo)
    return
  }
  if (modo === "comunicar") {
    await processarComunicar(input, decisao.modelo)
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

  let blocoSkills = ""
  try {
    const skillsAtivas = await selecionarSkills(input, process.cwd())
    if (skillsAtivas.length) {
      ui.subItem(`skill: ${skillsAtivas.map((s) => s.nome).join(", ")}`)
      logInterno(`skills ativadas=[${skillsAtivas.map((s) => `${s.nome}(${s.origem})`).join(", ")}]`)
      blocoSkills = montarBlocoSkills(skillsAtivas)
    }
  } catch (e) {
    logInterno(`skills: falha ao ativar (${msgErro(e)})`)
  }

  if (!heranca) {
    const tratado = await consertarBuildAterrado(input, openrouter, ctx, blocoSkills)
    if (tratado) return
  }

  if (!heranca && ehComplexo(decisao)) {
    const tratado = await orquestrarComplexo(input, openrouter, ctx, blocoSkills)
    if (tratado) return
  }

  let plano: Passo[] = []
  const contextoCirurgico = ""
  let tarefa = input
  let modeloExec = decisao.modelo
  let thinkingExec = thinking
  let tokensRaciocinio = 0
  let custoRaciocinio = 0
  let modelosDiag: string[] = []

  let diagTexto: string | null = null

  if (modo === "diagnostico") {
    const prep = await faseDiagnostico(input, openrouter, ctx, blocoSkills)
    if (prep.fim) return
    tarefa = prep.tarefa
    diagTexto = prep.diagTexto
    modelosDiag = prep.modelos
    tokensRaciocinio = prep.tokens
    custoRaciocinio = prep.custoUSD
    modeloExec = MODELOS.execucao
    thinkingExec = false
    registrarMastigado(prep.tarefa)
  } else if (heranca) {
    const anterior = mastigadoAnterior() as string
    tarefa = `${anterior}\n\nAjuste pedido pelo usuário agora: ${input}`
    definirEscopo(escopoDoDiagnostico(anterior))
    registrarMastigado(null)
  } else {
    const prep = await prepararExecucaoGuiada(input)
    plano = prep.plano
    tarefa = prep.tarefa
  }

  const passoRef = { atual: 0 }
  const sistema = montarSistema(ctx.completo, plano.map((p, i) => `${i + 1}. ${p.texto}`).join("\n"), contextoCirurgico, blocoSkills)
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

  if (deveReclassificarPraDiagnostico(modo, houveEdicao(), respostaFinal) && podeTrocarMarcha()) {
    registrarTrocaMarcha()
    modoFinal = "diagnostico"
    logInterno("reclassificacao execucao->diagnostico")
    const alvoRe = await ancorarAlvoDoRepo(input)
    const d = await diagnosticarEMastigar(input, openrouter, alvoRe)
    if (d.ok) {
      tokensRaciocinio += d.tokens
      custoRaciocinio += d.custoUSD
      modelosDiag = d.modelos
      diagTexto = d.texto
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
    } else if (d.motivo === "foraDoAlvo" && alvoRe) {

      tokensRaciocinio += d.tokens
      custoRaciocinio += d.custoUSD
      modelosDiag = d.modelos
      respostaFinal = montarRespostaForaDoAlvo(alvoRe, d.foraDoAlvo, d.texto)
    }
  }

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

  let gateFinal: GateFinal = "sem-gate"
  if (precisaTestGate(houveEdicao())) {
    const conserto = await rodarGateComConserto(
      { model: openrouter(modeloAtual) as Modelo, sistema, toolset, plano, passoRef },
      respostaFinal,
    )
    totalIn += conserto.inTok
    totalOut += conserto.outTok
    respostaFinal = conserto.resposta
    if (conserto.abortado) {
      finalizarAbort()
      return
    }
    if (conserto.erro) {
      ui.erro(msgErro(conserto.erro))
      historico.pop()
      return
    }
    gateFinal = mapaGateFinal(conserto.gate)
    respostaFinal += sufixoGate(conserto.gate)
  }

  await fecharTarefa({
    input,
    inicio,
    modoFinal,
    gateFinal,
    resposta: respostaFinal,
    diagTexto,
    modelosDiag,
    modeloAtual,
    tokens: totalIn + totalOut + tokensRaciocinio,
    custoUSD: custoUSD(modeloAtual, totalIn, totalOut) + custoRaciocinio,
    houveThinking: thinkingExec || esforco.thinking || modoFinal === "diagnostico",
  })
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
  const resposta = await consumirStreamAoVivo(result.textStream, (e) => {
    if (!ac.signal.aborted) erroCapturado = e
  })
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
  const { inTok, outTok } = await extrairUso(result.usage)
  const custo = local ? 0 : custoUSD(modeloCloud, inTok, outTok)
  ui.metricas(inTok + outTok, custo, Date.now() - inicio)
  await registrarTarefa({ modo: "conversa", modelo: modeloNome, thinking: false, tokens: inTok + outTok, custoUSD: custo, ms: Date.now() - inicio })
  historico.push({ role: "assistant", content: resposta })
  registrarDesfecho(resposta, "sem-gate")
}

async function streamLeitura(
  input: string,
  modo: Modo,
  rotulo: string,
  modeloCloud: string,
  sistema: string,
  thinking: boolean,
): Promise<void> {
  let openrouter: ReturnType<typeof provedor>
  try {
    openrouter = provedor()
  } catch (e) {
    ui.spinnerStop()
    ui.erro((e as Error).message)
    return
  }
  logInterno(`${modo} modelo=${modeloCloud} thinking=${thinking}`)
  historico.push({ role: "user", content: input })
  const inicio = Date.now()
  const ac = new AbortController()
  _abort = ac
  let erroCapturado: unknown = null
  const result = streamText({
    model: openrouter(modeloCloud) as Modelo,
    system: sistema,
    messages: historico.slice(-LIMITE_HISTORICO),
    stopWhen: stepCountIs(1),
    temperature: 0.3,
    abortSignal: ac.signal,
    providerOptions: thinking ? { openrouter: { reasoning: { effort: "medium" } } } : undefined,
    onStepFinish: () => ui.spinnerStart(`Jade ${rotulo}`),
    onError: ({ error }) => {
      erroCapturado = error
    },
  })

  const tty = Boolean(process.stdout.isTTY)
  const resposta = await consumirStreamAoVivo(result.textStream, (e) => {
    if (!ac.signal.aborted) erroCapturado = e
  })
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
  const { inTok, outTok } = await extrairUso(result.usage)
  const custo = custoUSD(modeloCloud, inTok, outTok)
  ui.metricas(inTok + outTok, custo, Date.now() - inicio)
  await registrarTarefa({ modo, modelo: modeloCloud, thinking, tokens: inTok + outTok, custoUSD: custo, ms: Date.now() - inicio })
  historico.push({ role: "assistant", content: resposta })
  registrarDesfecho(resposta, "sem-gate")
}

const MAX_CORPOS_COMPREENDER = 5

async function processarCompreender(input: string, ctx: { completo: string }, modeloCloud: string): Promise<void> {
  ui.jade("entendendo")
  ui.spinnerStart("Jade entendendo")
  const mapa = await montarMapaAmplo(process.cwd(), input, criarResumirFn())
  const corpos = await superficieDeArquivos(process.cwd(), mapa.arquivos.slice(0, MAX_CORPOS_COMPREENDER))
  const contexto = [mapa.texto, corpos?.texto].filter(Boolean).join("\n\n") || "(índice vazio — sem contexto disponível)"
  const sistema = SYSTEM_COMPREENDER.replace("{memoria_projeto}", ctx.completo || "(sem memória registrada)").replace("{mapa}", contexto)
  await streamLeitura(input, "compreender", "entendendo", modeloCloud, sistema, false)
}

async function processarPlanejar(input: string, ctx: { completo: string }, modeloCloud: string): Promise<void> {
  ui.jade("planejando")
  ui.spinnerStart("Jade planejando")
  const [mapa, precedentes] = await Promise.all([
    montarMapaAmplo(process.cwd(), input, criarResumirFn()),
    buscarPrecedente(process.cwd(), input),
  ])
  const precTexto = precedentes.length
    ? precedentes
        .map((p) => (p.tipo === "bug" ? `- bug: ${p.item.sintoma} -> ${p.item.causaRaiz}` : `- decisão: ${p.item.titulo}: ${p.item.decisao}`))
        .join("\n")
    : "(nenhum precedente registrado)"
  const sistema = SYSTEM_PLANEJAR.replace("{memoria_projeto}", ctx.completo || "(sem memória registrada)")
    .replace("{precedentes}", precTexto)
    .replace("{mapa}", mapa.texto || "(índice vazio)")

  await streamLeitura(input, "planejar", "planejando", modeloCloud, sistema, true)
}

const MAX_CHARS_DIFF = 14_000

async function processarComunicar(input: string, modeloCloud: string): Promise<void> {
  ui.jade("escrevendo")
  ui.spinnerStart("Jade escrevendo")
  let diff = (await rodar("git diff HEAD", undefined, 15_000)).saida.trim()
  if (!diff) diff = (await rodar("git show --stat --patch --no-color HEAD", undefined, 15_000)).saida.trim()
  if (!diff) {
    ui.spinnerStop()
    ui.aviso("não há mudança pra descrever — working tree limpo e sem commits.")
    return
  }
  const ranking = pontuarDiff(diff)
  const rankTexto = ranking.length
    ? ranking.slice(0, 12).map((m) => `- ${m.arquivo} (+${m.adicoes}/-${m.remocoes})`).join("\n")
    : "(diff sem arquivos detectáveis)"
  const sistema = SYSTEM_COMUNICAR.replace("{ranking}", rankTexto).replace("{diff}", diff.slice(0, MAX_CHARS_DIFF))
  await streamLeitura(input, "comunicar", "escrevendo", modeloCloud, sistema, false)
}

function finalizarAbort() {
  ui.linhaBranca()
  ui.aviso("cancelado")
  _abort = null
  historico.pop()
}

function rotuloModo(modo: string): string {
  if (modo === "diagnostico") return "diagnóstico"
  if (modo === "conversa") return "conversa"
  if (modo === "compreender") return "entendendo"
  if (modo === "planejar") return "planejando"
  if (modo === "comunicar") return "escrevendo"
  return "execução"
}

function logInterno(msg: string): void {
  if (process.env.ARARA_DEBUG === "1") process.stderr.write(`[jade] ${msg}\n`)
}
