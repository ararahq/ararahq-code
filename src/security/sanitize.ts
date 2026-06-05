import { resolve } from "node:path"

const PADROES: RegExp[] = [
  /(api[_-]?key|apikey)\s*[:=]\s*["']?[\w-]{16,}/gi,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /(password|passwd|senha|secret)\s*[:=]\s*["']?[^\s"']{6,}/gi,
  /(jdbc:|mongodb:\/\/|postgres:\/\/|mysql:\/\/|redis:\/\/)[\w:@.\-/]+/gi,
  /(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)\d+\.\d+/g,
]

export function sanitizar(conteudo: string): string {
  let r = conteudo
  for (const p of PADROES) r = r.replace(p, "[REDACTED]")
  return r
}

// Fachada Jade: o usuário NUNCA vê o nome do modelo real — nem quando pede pra Jade explicar a própria
// Jade (o modelo lê o slug no código e repetiria). Redação determinística na saída pro usuário; não
// depende do modelo obedecer. Pega slug `provedor/modelo` e nomes de família soltos (com versões).
const FACHADA: RegExp[] = [
  /\b(?:deepseek|google|openai|anthropic|moonshotai|meta-llama|mistralai|x-ai|cohere|ollama)\/[\w.\-:]+/gi,
  /\bdeepseek[\w.\-]*/gi,
  /\bgemini[\w.\-]*/gi,
  /\bgpt-[\w.\-]+/gi,
  /\bclaude[\w.\-]*/gi,
  /\b(?:opus|sonnet|haiku)-[\w.]+/gi,
  /\bkimi[\w.\-]*/gi,
  /\bmoonshot\w*/gi,
  /\bllama[\w.\-]*/gi,
  /\bqwen[\w.\-]*/gi,
]

/** Redige qualquer nome de modelo do texto voltado pro usuário, preservando a fachada Jade. */
export function blindarFachada(texto: string): string {
  let r = texto
  for (const p of FACHADA) r = r.replace(p, "o modelo")
  return r
}

function bloqueado(nome: string): boolean {
  if (nome === ".env" || nome.startsWith(".env.")) return true
  if (/\.(key|pem|p12|secret)$/i.test(nome)) return true
  if (nome.startsWith("secrets.") || nome.startsWith("credentials.")) return true
  return false
}

export function pathSeguro(caminho: string): string | null {
  const root = resolve(process.cwd())
  const alvo = resolve(root, caminho)
  if (alvo !== root && !alvo.startsWith(root + "/")) return null
  const nome = alvo.split("/").pop() ?? ""
  if (bloqueado(nome)) return null
  return alvo
}
