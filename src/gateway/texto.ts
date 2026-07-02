const RE_REPO_PREFIXO = /^\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*:\s+([\s\S]+)$/

export function separarRepo(texto: string): { repo: string | null; instrucao: string } {
  const m = texto.match(RE_REPO_PREFIXO)
  if (m) return { repo: m[1], instrucao: m[2].trim() }
  return { repo: null, instrucao: texto.trim() }
}

export function limparMencaoJade(texto: string): string {
  return texto.replace(/@jade\b/gi, " ").replace(/\s+/g, " ").trim()
}

export function ehString(v: unknown): v is string {
  return typeof v === "string"
}

export function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
