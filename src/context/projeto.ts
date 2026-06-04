import { readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { sanitizar } from "../security/sanitize"

const MANIFESTOS: [string, string][] = [
  ["package.json", "Node/TS"],
  ["go.mod", "Go"],
  ["build.gradle.kts", "Kotlin/Gradle"],
  ["build.gradle", "JVM/Gradle"],
  ["pom.xml", "Java/Maven"],
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
  ["Cargo.toml", "Rust"],
  ["composer.json", "PHP"],
  ["Gemfile", "Ruby"],
]

const CONTEXTO_EXTRA = ["CLAUDE.md", "AGENTS.md", "README.md"]
const IGNORAR = new Set([".git", "node_modules", "build", "bin", ".gradle", "dist", "out", "target", ".next", "vendor"])
const MAX_CTX = 4000

let cache: { completo: string; resumo: string } | null = null

export function resetContexto() {
  cache = null
}

export function hashRaiz(raiz: string): string {
  return createHash("sha1").update(raiz).digest("hex").slice(0, 12)
}

export function caminhoCache(raiz: string): string {
  return `${process.env.HOME}/.arara/projects/${hashRaiz(raiz)}/contexto.md`
}

async function stackDe(dir: string): Promise<string | null> {
  for (const [arq, label] of MANIFESTOS) {
    try {
      if (await Bun.file(`${dir}/${arq}`).exists()) return label
    } catch {}
  }
  return null
}

async function infoPackage(dir: string): Promise<string | null> {
  try {
    const p = (await Bun.file(`${dir}/package.json`).json()) as {
      description?: string
      scripts?: Record<string, unknown>
      dependencies?: Record<string, unknown>
    }
    const partes: string[] = []
    if (p.description) partes.push(p.description)
    const scripts = Object.keys(p.scripts ?? {})
    if (scripts.length) partes.push(`scripts: ${scripts.slice(0, 8).join(", ")}`)
    const deps = Object.keys(p.dependencies ?? {})
    if (deps.length) partes.push(`deps: ${deps.slice(0, 10).join(", ")}`)
    return partes.join(" · ") || null
  } catch {
    return null
  }
}

async function perfilDerivado(raiz: string, nome: string): Promise<{ texto: string; resumo: string }> {
  const linhas: string[] = [`Projeto: ${nome}`, `Diretorio: ${raiz}`]
  let resumo = nome

  const stackRaiz = await stackDe(raiz)
  if (stackRaiz) {
    linhas.push(`Stack: ${stackRaiz}`)
    const info = await infoPackage(raiz)
    if (info) linhas.push(info)
    resumo = `${nome} (${stackRaiz})`
  } else {
    let subs: string[] = []
    try {
      subs = (await readdir(raiz, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !IGNORAR.has(e.name) && !e.name.startsWith("."))
        .map((e) => e.name)
    } catch {}
    const projetos: string[] = []
    for (const s of subs.slice(0, 40)) {
      const st = await stackDe(`${raiz}/${s}`)
      if (st) projetos.push(`${s} (${st})`)
    }
    if (projetos.length) {
      linhas.push(`Tipo: workspace com ${projetos.length} subprojetos detectados:`)
      projetos.forEach((p) => linhas.push(`- ${p}`))
      const stacks = [...new Set(projetos.map((p) => p.match(/\(([^)]+)\)/)?.[1]).filter(Boolean))].slice(0, 4)
      resumo = `${nome} — workspace com ${projetos.length} projetos (${stacks.join(", ")})`
    } else {
      linhas.push("Tipo: pasta sem manifesto de projeto detectado.")
    }
  }

  for (const f of CONTEXTO_EXTRA) {
    try {
      const file = Bun.file(`${raiz}/${f}`)
      if (await file.exists()) {
        const txt = (await file.text()).slice(0, MAX_CTX).trim()
        if (txt) linhas.push(`\n### ${f}\n${sanitizar(txt)}`)
      }
    } catch {}
  }

  return { texto: linhas.join("\n"), resumo: resumo.slice(0, 240) }
}

async function lerSintese(raiz: string): Promise<string | null> {
  for (const p of [`${raiz}/ARARA.md`, caminhoCache(raiz)]) {
    try {
      const f = Bun.file(p)
      if (await f.exists()) {
        const t = (await f.text()).trim()
        if (t) return t
      }
    } catch {}
  }
  return null
}

export async function temSintese(raiz: string): Promise<boolean> {
  return (await lerSintese(raiz)) !== null
}

export async function carregarContexto(): Promise<{ completo: string; resumo: string }> {
  if (cache) return cache
  const raiz = process.cwd()
  const nome = raiz.split("/").filter(Boolean).pop() ?? "projeto"

  const derivado = await perfilDerivado(raiz, nome)
  const sintese = await lerSintese(raiz)

  const completo = sintese
    ? `${sintese.slice(0, 8000)}\n\n--- perfil derivado (automatico) ---\n${derivado.texto}`
    : derivado.texto

  const resumo = sintese
    ? (sintese
        .split("\n")
        .map((l) => l.replace(/[#>*`_-]/g, " ").trim())
        .find((l) => l.length > 20) ?? derivado.resumo
      ).slice(0, 240)
    : derivado.resumo

  cache = { completo, resumo }
  return cache
}
