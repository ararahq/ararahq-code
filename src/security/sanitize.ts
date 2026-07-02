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
