import type { generateText } from "ai"
import { provedor as provedorOpenRouter } from "./openrouter"

export type ModeloLLM = Parameters<typeof generateText>[0]["model"]
export type ProvedorLLM = (slug: string) => ModeloLLM

let fabrica: () => ProvedorLLM = () => {
  const p = provedorOpenRouter()
  return (slug: string) => p(slug) as ModeloLLM
}

export function registrarProvedor(f: () => ProvedorLLM): void {
  fabrica = f
}

export function provedorLLM(): ProvedorLLM {
  return fabrica()
}
