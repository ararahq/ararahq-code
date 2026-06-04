import { readdir, stat } from "node:fs/promises"
import { relative } from "node:path"

/** Diretórios que nunca entram no índice (build output, deps, VCS, caches). */
export const DIRS_IGNORADOS = new Set([
  ".git", "node_modules", "build", "bin", ".gradle", "dist", "out", "target", ".next", "vendor",
  "pgdata", ".github", ".idea", ".vscode", "coverage", ".venv", "__pycache__", ".smithery", "dumps",
  ".turbo", ".cache", "tmp", ".terraform",
])

/** Extensões de código-fonte que o mapa simbólico sabe extrair. Agnóstico de linguagem. */
export const EXTS_FONTE = new Set([
  "kt", "kts", "ts", "tsx", "js", "jsx", "mjs", "cjs", "java", "py", "go", "rs", "php", "rb",
])

const MAX_ARQUIVOS = 8000
const MAX_BYTES_ARQUIVO = 600_000
const MAX_PROFUNDIDADE = 12

export type ArquivoFonte = { caminho: string; mtimeMs: number; bytes: number }

function extensao(nome: string): string {
  const i = nome.lastIndexOf(".")
  return i < 0 ? "" : nome.slice(i + 1).toLowerCase()
}

/**
 * Varre a árvore a partir de `raiz` e devolve os arquivos-fonte (por extensão) com mtime e tamanho,
 * em caminho relativo à raiz. Caps duros pra não travar em monorepo grande: ignora dirs de build/deps,
 * pula arquivos acima de `MAX_BYTES_ARQUIVO` (gerados/minificados), limita profundidade e total.
 */
export async function listarFontes(raiz: string): Promise<ArquivoFonte[]> {
  const out: ArquivoFonte[] = []
  await caminhar(raiz, raiz, 0, out)
  return out
}

async function caminhar(raiz: string, dir: string, prof: number, out: ArquivoFonte[]): Promise<void> {
  if (prof > MAX_PROFUNDIDADE || out.length >= MAX_ARQUIVOS) return
  let entradas
  try {
    entradas = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entradas) {
    if (out.length >= MAX_ARQUIVOS) return
    if (e.name.startsWith(".") && e.name !== ".env.example") {
      if (e.isDirectory()) continue
    }
    const abs = `${dir}/${e.name}`
    if (e.isDirectory()) {
      if (DIRS_IGNORADOS.has(e.name)) continue
      await caminhar(raiz, abs, prof + 1, out)
      continue
    }
    if (!e.isFile()) continue
    if (!EXTS_FONTE.has(extensao(e.name))) continue
    try {
      const s = await stat(abs)
      if (s.size > MAX_BYTES_ARQUIVO) continue
      out.push({ caminho: relative(raiz, abs), mtimeMs: Math.floor(s.mtimeMs), bytes: s.size })
    } catch {
      // arquivo sumiu entre readdir e stat: ignora
    }
  }
}
