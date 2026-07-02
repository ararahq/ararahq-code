import { readdir } from "node:fs/promises"
import { perfilTermos } from "../engine/marques"
import { sanitizar } from "../security/sanitize"

export type Skill = {
  nome: string
  descricao: string
  caminho: string
  origem: string
  corpo: string

  termos: Set<string>
}

const PONTE_PT_EN: Record<string, string[]> = {
  segurança: ["security"], senha: ["password"], autenticação: ["authentication", "auth"], autorização: ["authorization"],
  criptografia: ["encryption", "crypto"], vulnerabilidade: ["vulnerability"], auditoria: ["audit"], ameaça: ["threat"],
  pagamento: ["payment", "billing"], pagamentos: ["payments", "billing"], fatura: ["invoice", "billing"], cobrança: ["billing", "charge"],
  assinatura: ["subscription", "signature"], preço: ["price", "pricing"], preços: ["pricing"], vendas: ["sales"],
  banco: ["database"], dados: ["data"], consulta: ["query"], fila: ["queue"], mensagem: ["message"], mensagens: ["messages"],
  usuário: ["user"], usuários: ["users"], desempenho: ["performance"], implantação: ["deployment", "deploy"], implantar: ["deploy"],
  teste: ["test", "testing"], testes: ["testing", "tests"], documentação: ["documentation", "docs"], requisitos: ["requirements"],
  gráfico: ["chart", "graph"], relatório: ["report"], planilha: ["spreadsheet"], anúncio: ["ad", "advertising"], anúncios: ["ads"],
  conteúdo: ["content"], crescimento: ["growth"], marca: ["brand"], componente: ["component"], integração: ["integration"],
}

export function expandirTermosLingua(termos: Map<string, number>): Map<string, number> {
  const out = new Map(termos)
  for (const t of termos.keys()) for (const en of PONTE_PT_EN[t] ?? []) out.set(en, (out.get(en) ?? 0) + 1)
  return out
}

const MIN_SCORE = 2

const TERMOS_GENERICOS = new Set([
  "test", "tests", "testing", "code", "coding", "data", "app", "application", "file", "files",
  "project", "build", "run", "fix", "error", "errors", "function", "method", "class", "feature",
  "bug", "task", "type", "value", "service",
])

const MAX_SKILLS = 2

const MAX_CORPO = 4000

let cache: { raiz: string; skills: Skill[] } | null = null

export function resetSkills(): void {
  cache = null
}

function raizesSkills(raiz: string): { dir: string; origem: string }[] {
  const home = process.env.HOME ?? ""
  const fontes: { dir: string; origem: string }[] = [
    { dir: `${raiz}/.claude/skills`, origem: "claude:projeto" },
    { dir: `${raiz}/.arara/skills`, origem: "arara:projeto" },
  ]
  if (home) {
    fontes.push({ dir: `${home}/.claude/skills`, origem: "claude:global" })
    fontes.push({ dir: `${home}/.arara/skills`, origem: "arara:global" })
  }

  for (const extra of (process.env.ARARA_SKILLS_DIRS ?? "").split(":").map((s) => s.trim()).filter(Boolean)) {
    fontes.push({ dir: extra, origem: "extra" })
  }
  return fontes
}

function parseFrontmatter(texto: string): { meta: Record<string, string>; corpo: string } {
  const m = texto.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, corpo: texto.trim() }
  const meta: Record<string, string> = {}
  for (const linha of m[1].split(/\r?\n/)) {
    const mm = linha.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!mm) continue
    let v = mm[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    meta[mm[1].toLowerCase()] = v
  }
  return { meta, corpo: m[2].trim() }
}

async function lerSkill(arquivo: string, nomePasta: string, origem: string): Promise<Skill | null> {
  try {
    const f = Bun.file(arquivo)
    if (!(await f.exists())) return null
    const { meta, corpo } = parseFrontmatter(await f.text())
    const nome = (meta.name || nomePasta).trim()
    if (!nome || !corpo) return null
    const descricao = (meta.description || "").trim()
    return {
      nome,
      descricao,
      caminho: arquivo,
      origem,
      corpo,
      termos: new Set(perfilTermos(`${nome} ${descricao}`).keys()),
    }
  } catch {
    return null
  }
}

async function lerRaiz(dir: string, origem: string): Promise<Skill[]> {
  let entradas: { name: string; isDirectory(): boolean }[]
  try {
    entradas = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Skill[] = []
  for (const e of entradas) {
    if (!e.isDirectory()) continue
    const s = await lerSkill(`${dir}/${e.name}/SKILL.md`, e.name, origem)
    if (s) out.push(s)
  }
  return out
}

export async function descobrirSkills(raiz: string): Promise<Skill[]> {
  if (cache && cache.raiz === raiz) return cache.skills
  const vistos = new Set<string>()
  const skills: Skill[] = []
  for (const { dir, origem } of raizesSkills(raiz)) {
    for (const s of await lerRaiz(dir, origem)) {
      const chave = s.nome.toLowerCase()
      if (vistos.has(chave)) continue
      vistos.add(chave)
      skills.push(s)
    }
  }
  cache = { raiz, skills }
  return skills
}

export type Evidencia = { score: number; especificos: number; ativa: boolean }

export function avaliar(termosTarefa: Map<string, number>, skill: Skill): Evidencia {
  let especificos = 0
  let genericos = 0
  for (const t of termosTarefa.keys()) {
    if (!skill.termos.has(t)) continue
    if (TERMOS_GENERICOS.has(t)) genericos++
    else especificos++
  }
  const tokensNome = skill.nome.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3)
  const nomeEspecificoCitado = tokensNome.some((tok) => !TERMOS_GENERICOS.has(tok) && termosTarefa.has(tok))
  const score = especificos + genericos + (nomeEspecificoCitado ? 2 : 0)
  const ativa = especificos >= 1 && score >= MIN_SCORE
  return { score, especificos, ativa }
}

export async function selecionarSkills(input: string, raiz: string): Promise<Skill[]> {
  const skills = await descobrirSkills(raiz)
  if (!skills.length) return []
  const termos = expandirTermosLingua(perfilTermos(input))
  return skills
    .map((s) => ({ s, ev: avaliar(termos, s) }))
    .filter((x) => x.ev.ativa)
    .sort((a, b) => b.ev.score - a.ev.score || a.s.nome.localeCompare(b.s.nome))
    .slice(0, MAX_SKILLS)
    .map((x) => x.s)
}

export function montarBlocoSkills(skills: Skill[]): string {
  if (!skills.length) return ""
  return skills
    .map((s) => {
      const corpo = sanitizar(s.corpo).slice(0, MAX_CORPO)
      const cab = `### Skill: ${s.nome}${s.descricao ? ` — ${s.descricao}` : ""}`
      return `${cab}\n${corpo}`
    })
    .join("\n\n")
}
