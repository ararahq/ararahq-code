import { readdir } from "node:fs/promises"
import { perfilTermos } from "../engine/marques"
import { sanitizar } from "../security/sanitize"

/**
 * Skills (camada de instrução especializada). Plug-and-play com o formato ABERTO de Agent Skills do
 * Claude: cada skill é uma pasta com um `SKILL.md` (frontmatter `name`/`description` + corpo em
 * markdown). A Jade DESCOBRE as skills já instaladas (Claude, projeto, ou qualquer outra ferramenta
 * que use o mesmo formato) e as ATIVA de forma DETERMINÍSTICA — casando o sintoma/tarefa com a
 * descrição via Marques (perfilTermos), ZERO modelo. Progressive disclosure: o corpo (caro em tokens)
 * só entra no prompt da skill que casou. É a tese da casa: o trabalho barato (achar a instrução certa)
 * acontece antes, sem pagar modelo.
 */

export type Skill = {
  nome: string
  descricao: string
  caminho: string
  origem: string
  corpo: string
  // Termos do nome+descrição (Marques), pré-computados pro casamento determinístico. Progressive
  // disclosure: casamos contra os METADADOS, nunca contra o corpo inteiro.
  termos: Set<string>
}

// Ponte de língua PT→EN (i18n GERAL — recurso linguístico como STOPWORDS, não tabela de domínio nem de
// código): as skills do ecossistema são escritas em inglês, mas o usuário digita PT. Expande os termos da
// TAREFA com o equivalente EN, pro casamento determinístico cruzar a língua. ZERO modelo (mantém a ativação
// rápida). Cognatos técnicos/negócio comuns — nada específico de skill ou tarefa.
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

/** Expande o mapa de termos com os equivalentes EN da ponte (soma, não destrói os PT). Puro, testável. */
export function expandirTermosLingua(termos: Map<string, number>): Map<string, number> {
  const out = new Map(termos)
  for (const t of termos.keys()) for (const en of PONTE_PT_EN[t] ?? []) out.set(en, (out.get(en) ?? 0) + 1)
  return out
}

// Casou >= MIN_SCORE termos distintos com a tarefa pra ativar (evita falso positivo de termo solto).
const MIN_SCORE = 2

// Termos genéricos demais pra ATIVAR uma skill sozinhos: descrevem quase toda tarefa de código. São
// recurso linguístico (classe de stopword de ativação), não tabela de domínio. Casam e pontuam, mas
// uma skill precisa de pelo menos UM termo ESPECÍFICO em comum — senão "faça os testes passarem"
// (Kotlin) ativa "web3-testing" só porque compartilham a palavra "testing". Pós-ponte PT→EN.
const TERMOS_GENERICOS = new Set([
  "test", "tests", "testing", "code", "coding", "data", "app", "application", "file", "files",
  "project", "build", "run", "fix", "error", "errors", "function", "method", "class", "feature",
  "bug", "task", "type", "value", "service",
])
// Quantas skills no máximo entram num prompt (protege o orçamento de tokens — não despeja a pasta toda).
const MAX_SKILLS = 2
// Teto do corpo injetado por skill (sanitizado). Skill gigante não estoura o contexto.
const MAX_CORPO = 4000

let cache: { raiz: string; skills: Skill[] } | null = null

/** Limpa o cache de descoberta (testes / troca de projeto). */
export function resetSkills(): void {
  cache = null
}

/**
 * Raízes onde procurar skills, da mais específica (projeto) pra mais ampla (global). A ordem importa:
 * skill de mesmo nome numa raiz anterior VENCE (o projeto sobrescreve o global). Cobre Claude (`.claude`),
 * a localização nativa (`.arara`) e qualquer outra via env `ARARA_SKILLS_DIRS` (ex.: outro agente/LLM).
 */
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
  // Escotilha pra "skills de outro LLM": qualquer lista de pastas, separadas por `:`.
  for (const extra of (process.env.ARARA_SKILLS_DIRS ?? "").split(":").map((s) => s.trim()).filter(Boolean)) {
    fontes.push({ dir: extra, origem: "extra" })
  }
  return fontes
}

/**
 * Frontmatter YAML mínimo (`---\nchave: valor\n---\ncorpo`). Parser próprio, sem dependência — só
 * pares `chave: valor` de uma linha, que é o que o formato de skill usa pra name/description. Sem
 * frontmatter, o texto inteiro é o corpo.
 */
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

/** Lê e parseia um SKILL.md. Degrada pra null (sem crashar) em I/O ruim — skill é auxiliar. */
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

/** Lista os SKILL.md de uma raiz: cada subpasta com um `SKILL.md` é uma skill. Pasta ausente => []. */
async function lerRaiz(dir: string, origem: string): Promise<Skill[]> {
  let entradas: { name: string; isDirectory(): boolean }[]
  try {
    entradas = await readdir(dir, { withFileTypes: true })
  } catch {
    return [] // raiz não existe: normal, segue
  }
  const out: Skill[] = []
  for (const e of entradas) {
    if (!e.isDirectory()) continue
    const s = await lerSkill(`${dir}/${e.name}/SKILL.md`, e.name, origem)
    if (s) out.push(s)
  }
  return out
}

/**
 * Descobre todas as skills instaladas, varrendo as raízes na ordem de precedência. Dedup por nome
 * (case-insensitive): a primeira raiz a definir um nome vence (projeto > global). Cacheado por raiz —
 * varrer disco uma vez por sessão basta.
 */
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

/**
 * Evidência de que uma skill casa com a tarefa. Distingue termos ESPECÍFICOS (sinal real) de
 * GENÉRICOS (ruído de qualquer tarefa de código). O boost de nome (+2) só vale pra token de nome
 * ESPECÍFICO citado — um token genérico como "testing" no nome "web3-testing" NÃO dá boost (era a
 * causa do falso-positivo). Ativa quando há >=1 termo específico em comum E o score cruza MIN_SCORE:
 * um "pdf" (específico, ainda que solto, batendo o nome) ativa; "testing" (genérico) sozinho não.
 * Puro, testável.
 */
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

/**
 * Seleciona, de forma DETERMINÍSTICA (Marques, zero modelo), as skills que casam com a tarefa. Casa
 * só contra os metadados (nome+descrição) — progressive disclosure. Retorna as MAX_SKILLS de maior
 * score entre as que ativaram, desempate estável por score e nome.
 */
export async function selecionarSkills(input: string, raiz: string): Promise<Skill[]> {
  const skills = await descobrirSkills(raiz)
  if (!skills.length) return []
  const termos = expandirTermosLingua(perfilTermos(input)) // ponte PT→EN: skills são em inglês
  return skills
    .map((s) => ({ s, ev: avaliar(termos, s) }))
    .filter((x) => x.ev.ativa)
    .sort((a, b) => b.ev.score - a.ev.score || a.s.nome.localeCompare(b.s.nome))
    .slice(0, MAX_SKILLS)
    .map((x) => x.s)
}

/**
 * Monta o bloco de skills pro system prompt: o corpo de cada skill ativada, sanitizado (redige
 * secrets — skill é arquivo externo) e com teto de tamanho. Vazio quando nenhuma casou — não polui o
 * prompt nem custa token à toa.
 */
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
