import {
  decidirModo,
  detectarComposta,
  temStackTrace,
  tamanhoPrevisto,
  respostaHedge,
  type Modo,
} from "../engine/marques"
import type { IndiceParaRef } from "../engine/refcodigo"
import { pareceLoopLongo } from "./planner"
import { PERFIS, perfilAtivo, type PerfilModelos } from "../config/perfis"

// Fonte da verdade dos perfis vive em ../config/perfis (módulo-folha, evita ciclo de import).
// Re-exportado aqui pra compatibilidade dos imports existentes (ui, testes).
export { PERFIS, PERFIL_PADRAO, perfilAtivo, provedorDoPerfil, MODELO_LOCAL, type PerfilModelos } from "../config/perfis"
import { MODELO_LOCAL } from "../config/perfis"

const PERFIL = PERFIS[perfilAtivo()]!

export type MarchasModelos = Pick<PerfilModelos, "execucao" | "diagnostico" | "loopLongo" | "compreender">

export const MODELOS: MarchasModelos = {
  execucao: PERFIL.execucao,
  diagnostico: PERFIL.diagnostico,
  loopLongo: PERFIL.loopLongo,
  compreender: PERFIL.compreender,
}

// Custo por 1M tokens (USD). Cobre todos os slugs de todos os perfis.
export const CUSTO: Record<string, { in: number; out: number }> = {
  "deepseek/deepseek-v4-flash": { in: 0.089, out: 0.18 },
  "deepseek/deepseek-v4-pro": { in: 0.435, out: 0.87 },
  "minimax/minimax-m3": { in: 0.3, out: 1.2 },
  "google/gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "qwen/qwen3.7-plus": { in: 0.32, out: 1.28 },
  "z-ai/glm-5.2": { in: 0.93, out: 3.0 },
  // perfil uncensored — low-refusal + tool-capable (pricing OpenRouter jul/2026)
  "mistralai/mistral-small-3.2-24b-instruct": { in: 0.075, out: 0.2 },
  "mistralai/mistral-large-2512": { in: 0.5, out: 1.5 },
  "mistralai/devstral-2512": { in: 0.4, out: 2.0 },
  "mistralai/mistral-nemo": { in: 0.02, out: 0.03 },
  "mistralai/mixtral-8x22b-instruct": { in: 2.0, out: 6.0 },
  "qwen/qwen3-coder-plus": { in: 0.65, out: 3.25 },
  // perfil local (Ollama) — roda na sua máquina, custo de API = zero
  [MODELO_LOCAL]: { in: 0, out: 0 },
}

export type Decisao = {
  modo: Modo
  thinking: boolean
  modelo: string
  motivo: string

  pedirQuebra?: boolean
}

let _ultimoMastigado: string | null = null

export function registrarMastigado(tarefa: string | null): void {
  _ultimoMastigado = tarefa
}

export function mastigadoAnterior(): string | null {
  return _ultimoMastigado
}

export function resetSessao(): void {
  _ultimoMastigado = null
}

export function rotear(input: string, indice?: IndiceParaRef): Decisao {

  const composta = detectarComposta(input, indice)
  if (composta?.tipo === "demais") {
    return { modo: "diagnostico", thinking: false, modelo: MODELOS.diagnostico, motivo: "muitas-intencoes", pedirQuebra: true }
  }
  const modo = composta ? "diagnostico" : decidirModo(input, indice)
  if (modo === "conversa") return { modo, thinking: false, modelo: MODELOS.execucao, motivo: "conversa" }

  if (modo === "compreender") return { modo, thinking: false, modelo: MODELOS.compreender, motivo: "compreender" }

  if (modo === "planejar") return { modo, thinking: true, modelo: MODELOS.diagnostico, motivo: "planejar" }

  if (modo === "comunicar") return { modo, thinking: false, modelo: MODELOS.execucao, motivo: "comunicar" }
  if (temStackTrace(input)) {
    return { modo: "diagnostico", thinking: true, modelo: MODELOS.diagnostico, motivo: "stack-trace" }
  }
  const tamanho = tamanhoPrevisto(input)
  if (pareceLoopLongo(input) || tamanho === "grande") {
    const motivo = tamanho === "grande" ? "tamanho-grande" : "loop-longo"
    return { modo, thinking: modo === "diagnostico", modelo: MODELOS.loopLongo, motivo }
  }
  if (modo === "diagnostico") return { modo, thinking: true, modelo: MODELOS.diagnostico, motivo: "diagnostico" }
  return { modo, thinking: false, modelo: MODELOS.execucao, motivo: "execucao" }
}

const ESCALADA: string[] = [MODELOS.execucao, MODELOS.loopLongo]

export type EstadoEscalada = { modeloAtual: string }

export function proximoModeloEscalada(estado: EstadoEscalada): string | null {
  const idx = ESCALADA.indexOf(estado.modeloAtual)
  if (idx < 0) return ESCALADA[1] ?? null
  return ESCALADA[idx + 1] ?? null
}

export type Esforco = { modelo: string; thinking: boolean }

export function subirEsforco(atual: Esforco): Esforco | null {
  if (!atual.thinking) return { modelo: atual.modelo, thinking: true }
  const proximo = proximoModeloEscalada({ modeloAtual: atual.modelo })
  return proximo ? { modelo: proximo, thinking: true } : null
}

export function deveReclassificarPraDiagnostico(modo: Modo, houveEdicao: boolean, resposta: string): boolean {
  if (modo !== "execucao") return false
  if (houveEdicao) return false
  return respostaHedge(resposta)
}

export const CADEIA_DIAGNOSTICO: string[] = [
  MODELOS.execucao,
  MODELOS.diagnostico,
  ...PERFIL.cauda,
]

export function proximoFallbackDiagnostico(modeloAtual: string): string | null {
  const idx = CADEIA_DIAGNOSTICO.indexOf(modeloAtual)
  if (idx < 0) return null
  return CADEIA_DIAGNOSTICO[idx + 1] ?? null
}

export function custoUSD(modelo: string, inTok: number, outTok: number): number {
  const c = CUSTO[modelo]
  if (!c) return 0
  return (inTok / 1_000_000) * c.in + (outTok / 1_000_000) * c.out
}
