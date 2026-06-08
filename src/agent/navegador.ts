// Loop de navegação multi-passo (rumo ao 8/8). O locator (Tier 1) acha o ARQUIVO; mas muitos bugs
// moram no CALL-SITE, não no arquivo nomeado (ex.: o dedup que não chama o Mutex — o bug não está em
// Mutex.kt). Aqui o modelo NAVEGA: abre arquivo, segue quem chama/é chamado, lê o ponto real, itera —
// com budget de passos e commit estruturado. Ferramentas read-only servidas do índice (com teto,
// anti-afogamento). Genérico: zero conhecimento de domínio; tudo vem do índice real do repo.
import { generateText, tool, stepCountIs } from "ai"
import { z } from "zod"
import type { Indice } from "../conhecimento"
import { ler, grep, vizinhosArquivo, simbolosDe } from "./navegacao"
import { detectouHedge } from "./diagnostico"

const MAX_PASSOS = Number(process.env.MAX_PASSOS ?? "6") // teto de passos; 6 medido melhor que 10 (menos timeout, +cravada)
// Budget de tempo INTERNO do loop: para de adicionar passos quando estoura, e força a conclusão a partir
// do que já investigou. Converte "timeout (perde tudo)" em "conclui do parcial" (CAUSA ou NÃO CRAVEI
// honesto) ANTES do abort externo. É o que mata o timeout de verdade — teto de passos não cobre passo lento.
const BUDGET_MS = Number(process.env.NAV_BUDGET_MS ?? "90000")
// Deadline DURO (backstop): se o loop OU a conclusão forçada estourarem (passo lento), aborta e devolve
// abstenção honesta do parcial — garante que o nav NUNCA bate o timeout externo (= zero "timeout perdido").
const DEADLINE_MS = Number(process.env.NAV_DEADLINE_MS ?? "150000")
const MAX_HITS_BUSCA = 12
const MAX_VIZINHOS = 20
const ORDEM_CONCLUIR =
  "Pare de investigar e conclua AGORA, sem usar ferramentas. Comece com \"CAUSA:\" (arquivo:linha + explicação curta) se tiver certeza do código que leu, ou \"NÃO CRAVEI:\" + os 2-3 arquivos mais prováveis se não tiver. Não invente."

const SISTEMA = `Você investiga a CAUSA-RAIZ de um bug num repositório que NÃO conhece. Você tem ferramentas read-only pra navegar o código. Estratégia:
1. Comece pelos arquivos candidatos dados. Abra-os (ler).
2. O bug costuma estar no CALL-SITE, não no arquivo de nome óbvio: siga quem chama / é chamado (vizinhos), abra o ponto real.
3. Bug de AUSÊNCIA é comum: algo que DEVERIA existir e não existe (sanitização que falta, lock que não é chamado, retry ausente, validação pulada). Procure o que está faltando no caminho do sintoma.
REGRAS:
- Só conclua sobre código que você LEU. Nunca invente caminho, símbolo ou linha.
- Quando tiver certeza, responda começando com "CAUSA:" seguido de arquivo:linha e a explicação curta.
- Se NÃO tiver certeza após investigar, responda começando com "NÃO CRAVEI:" e aponte os 2-3 arquivos mais prováveis pra um humano olhar. Não chute.`

/** Ferramentas read-only servidas do índice (com teto). O modelo as encadeia pra navegar até a causa. */
function ferramentas(raiz: string, indice: Indice) {
  return {
    ler: tool({
      description: "Lê uma janela de um arquivo (até 160 linhas). Use pra inspecionar o ponto suspeito.",
      inputSchema: z.object({
        caminho: z.string().describe("caminho relativo à raiz"),
        inicio: z.number().optional().describe("linha inicial (1-based)"),
        fim: z.number().optional().describe("linha final"),
      }),
      execute: async ({ caminho, inicio, fim }) => {
        const j = await ler(raiz, caminho, inicio ?? 1, fim ?? 120)
        if (!j) return `arquivo não encontrado: ${caminho}`
        return `${caminho} [${j.inicio}-${j.fim} de ${j.total}]\n${j.linhas.map((l, i) => `${j.inicio + i}\t${l}`).join("\n")}`
      },
    }),
    buscar: tool({
      description: "Busca um termo no conteúdo de todos os arquivos. Retorna arquivo:linha dos hits.",
      inputSchema: z.object({ termo: z.string().describe("identificador ou palavra-chave de código") }),
      execute: async ({ termo }) => {
        const hits = await grep(raiz, indice, termo, MAX_HITS_BUSCA)
        if (!hits.length) return `nenhum hit para "${termo}"`
        return hits.map((h) => `${h.arquivo}:${h.linha}  ${h.trecho}`).join("\n")
      },
    }),
    vizinhos: tool({
      description: "Quem este arquivo usa/chama e quem o usa (call-graph). Use pra ir do arquivo ao call-site.",
      inputSchema: z.object({ caminho: z.string().describe("caminho relativo à raiz") }),
      execute: async ({ caminho }) => {
        const v = vizinhosArquivo(indice, caminho).slice(0, MAX_VIZINHOS)
        if (!v.length) return `sem vizinhos resolvidos para ${caminho}`
        return v.map((x) => `${x.rel} -> ${x.arquivo}`).join("\n")
      },
    }),
    simbolos: tool({
      description: "Lista os símbolos (funções/classes) de um arquivo com a faixa de linhas.",
      inputSchema: z.object({ caminho: z.string().describe("caminho relativo à raiz") }),
      execute: async ({ caminho }) => {
        const s = simbolosDe(indice, caminho)
        if (!s.length) return `sem símbolos indexados para ${caminho}`
        return s.map((x) => `${x.tipo} ${x.nome} [${x.linhaInicio}-${x.linhaFim}]`).join("\n")
      },
    }),
  }
}

export type ResultadoNavegacao = { texto: string; inTok: number; outTok: number; cravou: boolean; passos: number }

/**
 * Diagnostica NAVEGANDO: dá o ticket + os candidatos do locator e deixa o modelo investigar com as
 * read-tools até `MAX_PASSOS`, então commitar (CAUSA: arquivo:linha, ou NÃO CRAVEI: + onde olhar).
 * cravou = produziu CAUSA sem hedge. É o passo "earned paid" do gate de custo: roda no shortlist já
 * localizado, não no repo cego.
 */
export async function navegarDiagnostico(
  input: string,
  raiz: string,
  indice: Indice,
  candidatos: string[],
  model: Parameters<typeof generateText>[0]["model"],
  signal?: AbortSignal,
): Promise<ResultadoNavegacao> {
  const lista = candidatos.length ? candidatos.map((c) => `- ${c}`).join("\n") : "(nenhum candidato pré-localizado; comece buscando)"
  const prompt = `SINTOMA (relato leigo do usuário):\n${input}\n\nARQUIVOS CANDIDATOS (ponto de partida, do localizador):\n${lista}\n\nInvestigue a causa-raiz navegando. Conclua com "CAUSA:" ou "NÃO CRAVEI:".`
  const t0 = Date.now()
  // Deadline duro: aborta nav+conclusão se estourar, combinado com o abort externo do chamador.
  const acHard = new AbortController()
  const timer = setTimeout(() => acHard.abort(), DEADLINE_MS)
  const sinal = signal ? AbortSignal.any([signal, acHard.signal]) : acHard.signal
  const abstencaoPorTempo = (): ResultadoNavegacao => ({
    texto: `NÃO CRAVEI: estourei o tempo de investigação. Prováveis: ${candidatos.slice(0, 3).join(", ") || "—"}.`,
    inTok: 0,
    outTok: 0,
    cravou: false,
    passos: 0,
  })

  let r
  try {
    r = await generateText({
      model,
      system: SISTEMA,
      prompt,
      tools: ferramentas(raiz, indice),
      // Para por teto de passos OU por budget de tempo (entre passos) — o que vier primeiro.
      stopWhen: [stepCountIs(MAX_PASSOS), () => Date.now() - t0 > BUDGET_MS],
      temperature: 0,
      abortSignal: sinal,
    })
  } catch (e) {
    clearTimeout(timer)
    if (acHard.signal.aborted) return abstencaoPorTempo() // deadline: abstém, não estoura o timeout externo
    throw e
  }
  let inTok = r.totalUsage?.inputTokens ?? r.usage?.inputTokens ?? 0
  let outTok = r.totalUsage?.outputTokens ?? r.usage?.outputTokens ?? 0
  let texto = r.text.trim()

  // Se gastou os passos em tool-calls sem concluir (texto vazio), força a conclusão do que investigou —
  // sob o MESMO deadline (se a conclusão estourar, fica vazio → abstém, sem travar).
  if (!texto && r.response?.messages?.length) {
    try {
      const f = await generateText({
        model,
        system: SISTEMA,
        messages: [...r.response.messages, { role: "user", content: ORDEM_CONCLUIR }],
        temperature: 0,
        abortSignal: sinal,
      })
      texto = f.text.trim()
      inTok += f.totalUsage?.inputTokens ?? f.usage?.inputTokens ?? 0
      outTok += f.totalUsage?.outputTokens ?? f.usage?.outputTokens ?? 0
    } catch (e) {
      if (!acHard.signal.aborted) throw e // erro real propaga; deadline → segue com texto vazio (abstém)
    }
  }
  clearTimeout(timer)
  return { texto, inTok, outTok, cravou: ehCravado(texto), passos: r.steps?.length ?? 0 }
}

// "CAUSA:" no INÍCIO de qualquer linha, tolerando bold markdown (**CAUSA:**) e indentação. O modelo
// barato às vezes crava certo mas com preâmbulo ("Já identifiquei a causa. Vou sintetizar.\n\n**CAUSA:**")
// — exigir que o texto INTEIRO comece com "CAUSA:" rejeitava acerto por formatação, subcontava e ainda
// escalava pra cadeia cara à toa. Não casa "NÃO CRAVEI:" (linha começa com "NÃO", não "CAUSA:").
const RE_CAUSA = /^[ \t>*_-]*\*{0,2}\s*CAUSA:/im

/** Cravou de verdade? Tem uma linha "CAUSA:" (não a abstenção "NÃO CRAVEI:") e não é hedge. */
export function ehCravado(texto: string): boolean {
  return RE_CAUSA.test(texto.trim()) && !detectouHedge(texto)
}
