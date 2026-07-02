import { generateText } from "ai"
import { ler } from "./navegacao"

const JANELA = 40
const VERIF_BUDGET_MS = Number(process.env.VERIF_BUDGET_MS ?? "25000")

const SISTEMA = `Você é um verificador CÉTICO de causa-raiz. Recebe um SINTOMA (relato leigo) e um TRECHO de código afirmado como a causa. Tarefa ÚNICA: esse código produz EXATAMENTE este sintoma?
MÉTODO obrigatório (faça antes de decidir):
1. Diga o que o sintoma EXIGE do código — que comportamento concreto geraria esse relato.
2. TRACE o caminho dentro do trecho: do gatilho até o efeito que o usuário descreve, passo a passo.
3. Não conseguiu traçar um mecanismo DIRETO e concreto até ESTE sintoma? Então é NAO.
REGRAS:
- 1ª linha: só "SIM" ou "NAO". Depois, o trace em 1-2 frases.
- "Achar um bug" NÃO basta: o trecho pode ter um bug REAL que não é a causa DESTE sintoma → NAO.
- Default é NAO. Só SIM se você traçou o mecanismo e apostaria nele. Qualquer elo faltando ou assumido → NAO.`

const RE_LINHA_CAUSA = /^[ \t>*_-]*\*{0,2}\s*CAUSA:/im
const RE_ALVO = /([\w./@-]+\.[A-Za-z][A-Za-z0-9]*):(\d+)/

export function extrairCausaAlvo(texto: string): { arquivo: string; linha: number } | null {
  const linhaCausa = texto.split("\n").find((l) => RE_LINHA_CAUSA.test(l.trim()))
  if (!linhaCausa) return null
  const m = linhaCausa.match(RE_ALVO)
  return m ? { arquivo: m[1], linha: Number(m[2]) } : null
}

export type Verificacao = { confirma: boolean; motivo: string; inTok: number; outTok: number }

export function interpretarVeredito(texto: string): boolean {
  const primeira = texto.trim().split("\n")[0]?.trim() ?? ""
  return /^sim\b/i.test(primeira)
}

async function trechoAfirmado(raiz: string, arquivo: string, linha: number): Promise<string> {
  const inicio = Math.max(1, linha - Math.floor(JANELA / 2))
  const j = await ler(raiz, arquivo, inicio, inicio + JANELA - 1)
  if (!j) return "(arquivo não encontrado)"
  return j.linhas.map((l, i) => `${j.inicio + i}\t${l}`).join("\n")
}

export async function verificarCausa(
  sintoma: string,
  raiz: string,
  arquivo: string,
  linha: number,
  model: Parameters<typeof generateText>[0]["model"],
  signal?: AbortSignal,
): Promise<Verificacao> {
  const codigo = await trechoAfirmado(raiz, arquivo, linha)
  const prompt = `SINTOMA:\n${sintoma}\n\nCAUSA AFIRMADA: ${arquivo}:${linha}\nCÓDIGO (janela):\n${codigo}\n\nSiga o MÉTODO: (1) o que o sintoma exige, (2) trace o caminho, (3) decida. 1ª linha SIM/NAO.`

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), VERIF_BUDGET_MS)
  const sinal = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal
  try {
    const r = await generateText({ model, system: SISTEMA, prompt, temperature: 0, abortSignal: sinal })
    clearTimeout(timer)
    const motivo = r.text.trim()
    return {
      confirma: interpretarVeredito(motivo),
      motivo,
      inTok: r.totalUsage?.inputTokens ?? r.usage?.inputTokens ?? 0,
      outTok: r.totalUsage?.outputTokens ?? r.usage?.outputTokens ?? 0,
    }
  } catch (e) {
    clearTimeout(timer)
    if (ac.signal.aborted) return { confirma: true, motivo: "verify estourou o tempo — mantém a cravada", inTok: 0, outTok: 0 }
    throw e
  }
}
