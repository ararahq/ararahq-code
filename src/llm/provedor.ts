import type { generateText } from "ai"
import { provedor as provedorOpenRouter } from "./openrouter"
import { provedorOllama } from "./ollama"
import { provedorDoPerfil } from "../config/perfis"

export type ModeloLLM = Parameters<typeof generateText>[0]["model"]
export type ProvedorLLM = (slug: string) => ModeloLLM

// Perfil "local" roteia o loop agêntico inteiro pro Ollama (uncensored, na máquina).
// Qualquer outro perfil usa o OpenRouter. Decidido por perfil pra valer em todos os
// entrypoints (CLI, gateway, autônomo) sem cada um precisar religar o provedor.
let fabrica: () => ProvedorLLM = () => {
  const p = provedorDoPerfil() === "ollama" ? provedorOllama() : provedorOpenRouter()
  return (slug: string) => p(slug) as ModeloLLM
}

export function registrarProvedor(f: () => ProvedorLLM): void {
  fabrica = f
}

export function provedorLLM(): ProvedorLLM {
  return fabrica()
}
