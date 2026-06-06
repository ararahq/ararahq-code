// Verificador sintoma→causa (escalonamento SELETIVO). O modelo BARATO diagnostica e crava "CAUSA:
// arquivo:linha". O erro dominante medido não é alucinação — é "grounded-but-wrong": acha um bug REAL,
// num arquivo plausível, mas NÃO o do ticket. Calibração de confiança não pega isso (o modelo está
// confiante). Então gastamos o modelo FORTE em UM único passo decisivo: ele lê só o trecho afirmado e
// julga, cético, se aquele código de fato PRODUZ aquele sintoma. Se não → rebaixa pra abstenção honesta.
// Custo: 1 chamada forte por diagnóstico que cravou (não por passo, não no repo cego). "Comprar fronteira
// no varejo": o caro entra só onde é decisivo, sobre material mínimo (uma janela), não sobre o repo todo.
import { generateText } from "ai"
import { ler } from "./navegacao"

const JANELA = 40 // linhas ao redor da linha afirmada (anti-afogamento; o forte lê só o ponto)

const SISTEMA = `Você é um verificador CÉTICO de causa-raiz. Recebe um SINTOMA (relato leigo de bug) e um TRECHO de código que alguém afirmou ser a causa. Sua ÚNICA tarefa: esse código produz ESSE sintoma?
REGRAS:
- 1ª linha: só "SIM" ou "NAO".
- 2ª linha: uma frase com o MECANISMO concreto que liga o código ao sintoma (ou por que não liga).
- Seja cético. Achar "um bug" no código NÃO basta — tem que ser a causa DESTE sintoma específico. Se a ligação não for clara e mecânica, responda NAO. Na dúvida, NAO.`

// "CAUSA: arquivo:linha" → {arquivo, linha}. Exige :linha (o verificador precisa do ponto pra ler a
// janela). Tolera preâmbulo/bold (igual ehCravado). null se não há linha CAUSA com arquivo:linha.
const RE_LINHA_CAUSA = /^[ \t>*_-]*\*{0,2}\s*CAUSA:/im
const RE_ALVO = /([\w./@-]+\.[A-Za-z][A-Za-z0-9]*):(\d+)/

export function extrairCausaAlvo(texto: string): { arquivo: string; linha: number } | null {
  const linhaCausa = texto.split("\n").find((l) => RE_LINHA_CAUSA.test(l.trim()))
  if (!linhaCausa) return null
  const m = linhaCausa.match(RE_ALVO)
  return m ? { arquivo: m[1], linha: Number(m[2]) } : null
}

export type Verificacao = { confirma: boolean; motivo: string; inTok: number; outTok: number }

/** Interpreta o veredito: confirma só se a 1ª linha começa com SIM (não NAO/NÃO). Puro, testável. */
export function interpretarVeredito(texto: string): boolean {
  const primeira = texto.trim().split("\n")[0]?.trim() ?? ""
  return /^sim\b/i.test(primeira)
}

/** Janela de código ao redor da linha afirmada, numerada. Lê só o ponto (o forte não varre o repo). */
async function trechoAfirmado(raiz: string, arquivo: string, linha: number): Promise<string> {
  const inicio = Math.max(1, linha - Math.floor(JANELA / 2))
  const j = await ler(raiz, arquivo, inicio, inicio + JANELA - 1)
  if (!j) return "(arquivo não encontrado)"
  return j.linhas.map((l, i) => `${j.inicio + i}\t${l}`).join("\n")
}

/**
 * Verifica, com o modelo FORTE, se a causa afirmada (arquivo:linha) realmente produz o sintoma. Lê só a
 * janela do ponto. Cético por design: na dúvida devolve `confirma=false` → o chamador rebaixa pra
 * abstenção honesta. É o passo de escalonamento seletivo do gate de custo.
 */
export async function verificarCausa(
  sintoma: string,
  raiz: string,
  arquivo: string,
  linha: number,
  model: Parameters<typeof generateText>[0]["model"],
  signal?: AbortSignal,
): Promise<Verificacao> {
  const codigo = await trechoAfirmado(raiz, arquivo, linha)
  const prompt = `SINTOMA:\n${sintoma}\n\nCAUSA AFIRMADA: ${arquivo}:${linha}\nCÓDIGO (janela):\n${codigo}\n\nEsse código produz ESSE sintoma? Responda "SIM" ou "NAO" na 1ª linha + 1 frase do mecanismo.`
  const r = await generateText({ model, system: SISTEMA, prompt, temperature: 0, abortSignal: signal })
  const motivo = r.text.trim()
  return {
    confirma: interpretarVeredito(motivo),
    motivo,
    inTok: r.totalUsage?.inputTokens ?? r.usage?.inputTokens ?? 0,
    outTok: r.totalUsage?.outputTokens ?? r.usage?.outputTokens ?? 0,
  }
}
