import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

const BASE = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "")

let modeloCache: string | null | undefined
let provedorCache: ReturnType<typeof createOpenAICompatible> | null = null

export async function modeloOllama(): Promise<string | null> {
  if (modeloCache !== undefined) return modeloCache
  try {
    const r = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) {
      modeloCache = null
      return null
    }
    const data = (await r.json()) as { models?: { name: string }[] }
    const nomes = (data.models ?? []).map((m) => m.name)
    const escore = (n: string) =>
      /coder|code/i.test(n) ? 0 : /qwen/i.test(n) ? 1 : /llama-?3\.1/i.test(n) ? 2 : /dolphin/i.test(n) ? 9 : 5
    modeloCache = nomes.length ? [...nomes].sort((a, b) => escore(a) - escore(b))[0] : null
  } catch {
    modeloCache = null
  }
  return modeloCache
}

export function provedorOllama() {
  if (!provedorCache) {
    provedorCache = createOpenAICompatible({ name: "ollama", baseURL: `${BASE}/v1`, apiKey: "ollama" })
  }
  return provedorCache
}
