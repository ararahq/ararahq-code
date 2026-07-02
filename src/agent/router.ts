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

export const MODELOS = {
  execucao: "deepseek/deepseek-v4-flash",
  diagnostico: "deepseek/deepseek-v4-pro",
  loopLongo: "minimax/minimax-m3",

  compreender: "google/gemini-2.5-flash-lite",
} as const

export const CUSTO: Record<string, { in: number; out: number }> = {
  "deepseek/deepseek-v4-flash": { in: 0.089, out: 0.18 },
  "deepseek/deepseek-v4-pro": { in: 0.435, out: 0.87 },
  "minimax/minimax-m3": { in: 0.3, out: 1.2 },
  "google/gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "qwen/qwen3.7-plus": { in: 0.32, out: 1.28 },
  "z-ai/glm-5.2": { in: 0.93, out: 3.0 },
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
  "qwen/qwen3.7-plus",
  "z-ai/glm-5.2",
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
