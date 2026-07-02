// Camada 2 — navegação. Em vez de montar um pacote estático e entregar pronto (que não alcança o
// arquivo lexicalmente ausente e afoga o modelo barato quando é grande), aqui o agente EXPLORA o repo
// com um toolset pequeno, servido do índice + leituras de disco limitadas. Tudo é genérico: nenhum
// caminho, linguagem ou termo de domínio é chumbado — o mapa vem da centralidade do grafo real e a
// tradução "sintoma → código" vem dos tokens do próprio ticket, verificada pelo retorno do grep.
//
// Este arquivo é o SCAFFOLDING determinístico (grátis): as ações de navegação + um explorador que as
// encadeia sem modelo, pra medir "alcançou o arquivo certo em ≤K passos?" antes de gastar key. Se nem
// o explorador burro alcança via estas ferramentas, modelo nenhum alcança — conserta a ferramenta.

import { statSync } from "node:fs"
import type { Indice } from "../conhecimento"
import type { Simbolo } from "../conhecimento"
import { perfilTermos, extrairEntidades, ehGenerico } from "../engine/marques"

const MAX_JANELA_LER = 160
const MAX_HITS_GREP = 30
const MAX_TERMOS_BUSCA = 8
const HOPS_PADRAO = 2

/**
 * Cache de conteúdo por processo (path -> {mtime, texto, linhas}), VALIDADO por mtime. A navegação
 * multi-passo relê os milhares de arquivos do repo a cada `grep` (10 passos × várias buscas) — em repo
 * grande isso é o gargalo (~80s/diagnóstico). Cachear lê do disco 1× e reusa; o check de mtime garante
 * que um arquivo editado não sirva stale (o diagnóstico é read-only, mas a CLI vive entre operações).
 * `statSync` é ~100× mais barato que reler o conteúdo. Genérico, sem estado de domínio.
 */
const cacheConteudo = new Map<string, { mtimeMs: number; texto: string; linhas: string[] }>()

async function conteudo(raiz: string, arquivo: string): Promise<{ texto: string; linhas: string[] } | null> {
  const path = `${raiz}/${arquivo}`
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return null
  }
  const hit = cacheConteudo.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit
  try {
    const texto = await Bun.file(path).text()
    const entrada = { mtimeMs, texto, linhas: texto.split("\n") }
    cacheConteudo.set(path, entrada)
    return entrada
  } catch {
    return null
  }
}

/** Esvazia o cache de conteúdo (uso em teste / após mutações em lote). */
export function limparCacheConteudo(): void {
  cacheConteudo.clear()
}

/** Arquivo dono de um nó do grafo. `f:caminho` → caminho; `s:caminho#nome` → caminho. */
export function arquivoDoNo(id: string): string {
  const corpo = id.slice(2) // tira "f:" ou "s:"
  const cerquilha = corpo.indexOf("#")
  return cerquilha >= 0 ? corpo.slice(0, cerquilha) : corpo
}

/**
 * Mapa do repo por CENTRALIDADE (genérico, derivado do grafo): os arquivos mais acoplados ao resto do
 * projeto são a espinha onde a lógica concentra — bons pontos de partida pra navegar. Conta só
 * acoplamento ENTRE arquivos (ignora chamadas internas), pra medir conexão com o resto, não coesão.
 */
export function entrypoints(indice: Indice, n = 12): { arquivo: string; grau: number }[] {
  const defs = defsPorNome(indice)
  const grau = new Map<string, number>()
  const bump = (arq: string) => grau.set(arq, (grau.get(arq) ?? 0) + 1)
  // Acoplamento entre arquivos pela resolução de nome único — funciona em same-package (Kotlin/Java),
  // onde o grafo estrito (que exige import) não liga nada.
  for (const a of indice.simbolos) {
    for (const v of vizinhosArquivo(indice, a.arquivo, defs)) {
      bump(a.arquivo)
      bump(v.arquivo)
    }
  }
  return [...grau.entries()]
    .map(([arquivo, g]) => ({ arquivo, grau: g }))
    .sort((x, y) => y.grau - x.grau || x.arquivo.localeCompare(y.arquivo))
    .slice(0, n)
}

/** Resumo de diretórios sob um prefixo (pra não despejar 2000 arquivos). Genérico: deriva da árvore. */
export function dirs(indice: Indice, prefixo = "", max = 40): { caminho: string; arquivos: number }[] {
  const cont = new Map<string, number>()
  for (const s of indice.simbolos) {
    if (!s.arquivo.startsWith(prefixo)) continue
    const resto = s.arquivo.slice(prefixo.length)
    const corte = resto.indexOf("/")
    const chave = corte >= 0 ? prefixo + resto.slice(0, corte) + "/" : prefixo + resto
    cont.set(chave, (cont.get(chave) ?? 0) + 1)
  }
  return [...cont.entries()]
    .map(([caminho, arquivos]) => ({ caminho, arquivos }))
    .sort((x, y) => y.arquivos - x.arquivos || x.caminho.localeCompare(y.caminho))
    .slice(0, max)
}

/** Lista arquivos sob um prefixo (ordenados, com teto). Ação `listar` do toolset. */
export function listar(indice: Indice, prefixo = "", max = 60): string[] {
  return indice.simbolos
    .map((s) => s.arquivo)
    .filter((a) => a.startsWith(prefixo))
    .sort()
    .slice(0, max)
}

/** Símbolos de um arquivo (nome, tipo, faixa de linhas, assinatura). Ação `simbolos`. */
export function simbolosDe(indice: Indice, arquivo: string): Simbolo[] {
  return indice.simbolos.find((s) => s.arquivo === arquivo)?.simbolos ?? []
}

/** Nome de símbolo → arquivos que o definem. Base da resolução por nome (mais permissiva que o grafo). */
export function defsPorNome(indice: Indice): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const a of indice.simbolos) {
    for (const s of a.simbolos) {
      const l = m.get(s.nome)
      if (l) {
        if (!l.includes(a.arquivo)) l.push(a.arquivo)
      } else {
        m.set(s.nome, [a.arquivo])
      }
    }
  }
  return m
}

/**
 * Vizinhos de um arquivo por RESOLUÇÃO DE NOME ÚNICO — liga uma chamada/tipo/herança ao arquivo que
 * define aquele nome, mesmo SEM import (Kotlin/Java same-package não importa). Só liga quando o nome
 * tem definição única no projeto: nome ambíguo (vários defs) ou ruído (palavra sem def) cai fora
 * sozinho. É a versão de navegação, mais permissiva que o grafo conservador usado no diagnóstico.
 */
export function vizinhosArquivo(
  indice: Indice,
  arquivo: string,
  defs: Map<string, string[]> = defsPorNome(indice),
): { rel: string; arquivo: string }[] {
  const eu = indice.simbolos.find((s) => s.arquivo === arquivo)
  if (!eu) return []
  const achados = new Map<string, string>()
  const liga = (nome: string, rel: string) => {
    const d = defs.get(nome)
    if (d && d.length === 1 && d[0] !== arquivo && !achados.has(d[0])) achados.set(d[0], rel)
  }
  for (const s of eu.simbolos) {
    for (const c of s.chama) liga(c, `chama:${c}`)
    for (const t of s.usaTipo) liga(t, `tipo:${t}`)
    for (const h of s.herda) liga(h, `herda:${h}`)
  }
  return [...achados.entries()].map(([arq, rel]) => ({ rel, arquivo: arq }))
}

function comoRegex(padrao: string): RegExp {
  try {
    return new RegExp(padrao, "i")
  } catch {
    return new RegExp(padrao.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
  }
}

/** Busca um padrão no conteúdo dos arquivos indexados. Ação `grep`: retorna hits {arquivo, linha, trecho} com teto. */
export async function grep(
  raiz: string,
  indice: Indice,
  padrao: string,
  max = MAX_HITS_GREP,
): Promise<{ arquivo: string; linha: number; trecho: string }[]> {
  const re = comoRegex(padrao)
  const hits: { arquivo: string; linha: number; trecho: string }[] = []
  for (const s of indice.simbolos) {
    const c = await conteudo(raiz, s.arquivo)
    if (!c) continue
    const linhas = c.linhas
    for (let i = 0; i < linhas.length; i++) {
      if (!re.test(linhas[i])) continue
      hits.push({ arquivo: s.arquivo, linha: i + 1, trecho: linhas[i].trim().slice(0, 200) })
      if (hits.length >= max) return hits
    }
  }
  return hits
}

/** Janela limitada de um arquivo. Ação `ler`: nunca devolve o arquivo inteiro (anti-afogamento). */
export async function ler(
  raiz: string,
  arquivo: string,
  inicio = 1,
  fim = 120,
): Promise<{ arquivo: string; inicio: number; fim: number; linhas: string[]; total: number } | null> {
  const c = await conteudo(raiz, arquivo)
  if (!c) return null
  const todas = c.linhas
  const i0 = Math.max(1, inicio)
  const i1 = Math.min(todas.length, Math.max(i0, Math.min(fim, i0 + MAX_JANELA_LER - 1)))
  return { arquivo, inicio: i0, fim: i1, linhas: todas.slice(i0 - 1, i1), total: todas.length }
}

/** Termos de busca derivados do ticket: entidades + tokens não-genéricos, dedup, top-N. Sem tabela chumbada. */
export function termosDeBusca(input: string): string[] {
  const perfil = [...perfilTermos(input).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t)
    .filter((t) => !ehGenerico(t))
  const vistos = new Set<string>()
  const out: string[] = []
  for (const t of [...extrairEntidades(input), ...perfil]) {
    const k = t.toLowerCase()
    if (k.length < 3 || vistos.has(k)) continue
    vistos.add(k)
    out.push(t)
    if (out.length >= MAX_TERMOS_BUSCA) break
  }
  return out
}

export type Alcance = { arquivo: string; via: string; passo: number }

/**
 * Explorador DETERMINÍSTICO (grátis): grep nos termos do ticket → segue o call-graph dos hits até
 * `hops` saltos. Baseline pra medir "alcançou o arquivo certo em ≤K passos?". O salto de grafo é o
 * que pega o arquivo lexicalmente AUSENTE: o sintoma casa um controller, o controller chama um
 * service → alcança o service mesmo sem casar lexicalmente. Se isto alcança, um modelo alcança mais.
 */
export async function explorar(
  raiz: string,
  indice: Indice,
  input: string,
  opts: { K?: number; hops?: number; termos?: string[] } = {},
): Promise<Alcance[]> {
  const K = opts.K ?? MAX_TERMOS_BUSCA
  const hops = opts.hops ?? HOPS_PADRAO
  // termos explícitos (ex.: harness passa a versão com ponte PT→EN) ou derivados do ticket (genérico).
  const termos = opts.termos ?? termosDeBusca(input)
  const alcancados = new Map<string, { via: string; passo: number }>()
  let passo = 0

  // Fase 1: grep dos termos do ticket.
  for (const t of termos) {
    if (passo >= K) break
    passo++
    for (const h of await grep(raiz, indice, t, MAX_HITS_GREP)) {
      if (!alcancados.has(h.arquivo)) alcancados.set(h.arquivo, { via: `grep:${t}`, passo })
    }
  }

  // Fase 2: BFS por resolução de nome a partir dos hits, até `hops` saltos. É o que alcança o arquivo
  // lexicalmente ausente: o termo casa um arquivo, e ele chama/usa um símbolo definido em outro.
  const defs = defsPorNome(indice)
  let fronteira = [...alcancados.keys()]
  for (let salto = 1; salto <= hops && fronteira.length; salto++) {
    passo++
    const proxima: string[] = []
    for (const arq of fronteira) {
      for (const v of vizinhosArquivo(indice, arq, defs)) {
        if (alcancados.has(v.arquivo)) continue
        alcancados.set(v.arquivo, { via: `nav:${v.rel}@${salto}`, passo })
        proxima.push(v.arquivo)
      }
    }
    fronteira = proxima
  }

  return [...alcancados.entries()]
    .map(([arquivo, m]) => ({ arquivo, ...m }))
    .sort((a, b) => a.passo - b.passo || a.arquivo.localeCompare(b.arquivo))
}

const PESO_ESTRUTURAL = 3
const FRACAO_GRAFO = 0.5
const BOOST_CENTRALIDADE = 0.3
const SEMENTES_GRAFO = 8
const TOP_CENTRAIS = 40
const LOTE_LEITURA = 64

/** Casa o termo no INÍCIO de uma palavra (raiz), case-insensitive: `auth` casa `authenticate`, não `oauth`. */
function reTermo(termo: string): RegExp {
  return new RegExp(`\\b${termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")
}

/** O termo casa o NOME do arquivo ou de algum símbolo dele? Match estrutural pesa muito mais que menção no corpo. */
function casaEstrutura(termo: string, arquivo: string, indice: Indice): boolean {
  const t = termo.toLowerCase()
  if (arquivo.toLowerCase().includes(t)) return true
  return simbolosDe(indice, arquivo).some((s) => s.nome.toLowerCase().includes(t))
}

export type Candidato = { arquivo: string; score: number; estrutural: boolean; termos: string[] }

/**
 * Localizador ranqueado (Tier 1 do gate de custo): dado termos de busca já em vocabulário de código,
 * pontua arquivos por relevância. Lever medido (repo real, reach 2→7/8):
 * - IDF: termo RARO (mutex, ssrf) pesa mais que comum (error, request) — separa sinal de ruído.
 * - match ESTRUTURAL (termo no nome do arquivo/símbolo) ×3 — é o sinal de CONFIANÇA do gate.
 * - salto de grafo: vizinho herda fração do score (alcança o ausente).
 * - centralidade: desempate leve pela espinha do repo.
 * `estrutural=true` no topo é o que libera escalar pro pago; senão, shortlist ou abstém.
 */
export async function ranquearCandidatos(raiz: string, indice: Indice, termos: string[]): Promise<Candidato[]> {
  if (!termos.length) return []
  const res = termos.map(reTermo)
  const casados = new Map<string, number[]>()
  const df = new Array(termos.length).fill(0)
  // I/O em paralelo por lotes — ler ~2k arquivos em série estourava o tempo em repos grandes.
  const arquivos = indice.simbolos.map((s) => s.arquivo)
  for (let ini = 0; ini < arquivos.length; ini += LOTE_LEITURA) {
    const lote = arquivos.slice(ini, ini + LOTE_LEITURA)
    const textos = await Promise.all(lote.map(async (a) => (await conteudo(raiz, a))?.texto ?? null))
    for (let j = 0; j < lote.length; j++) {
      const txt = textos[j]
      if (txt == null) continue
      const quais: number[] = []
      for (let i = 0; i < res.length; i++) {
        if (res[i].test(txt)) {
          quais.push(i)
          df[i]++
        }
      }
      if (quais.length) casados.set(lote[j], quais)
    }
  }

  const N = Math.max(1, indice.simbolos.length)
  const idf = df.map((d) => Math.log(1 + N / (1 + d)))
  const score = new Map<string, number>()
  const estrut = new Map<string, boolean>()
  const quaisTermos = new Map<string, string[]>()
  for (const [arq, quais] of casados) {
    let s = 0
    let est = false
    for (const i of quais) {
      const e = casaEstrutura(termos[i], arq, indice)
      s += idf[i] * (e ? PESO_ESTRUTURAL : 1)
      if (e) est = true
    }
    score.set(arq, s)
    estrut.set(arq, est)
    quaisTermos.set(arq, quais.map((i) => termos[i]))
  }

  // salto de grafo: vizinhos das melhores sementes herdam fração do score (alcança o ausente).
  const defs = defsPorNome(indice)
  const sementes = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, SEMENTES_GRAFO)
  for (const [sem, sc] of sementes) {
    for (const v of vizinhosArquivo(indice, sem, defs)) {
      if (!score.has(v.arquivo)) {
        score.set(v.arquivo, sc * FRACAO_GRAFO)
        quaisTermos.set(v.arquivo, [`grafo:${sem}`])
      }
    }
  }

  const central = new Set(entrypoints(indice, TOP_CENTRAIS).map((e) => e.arquivo))
  for (const [f, s] of score) if (central.has(f)) score.set(f, s + BOOST_CENTRALIDADE)

  return [...score.entries()]
    .map(([arquivo, s]) => ({ arquivo, score: s, estrutural: estrut.get(arquivo) ?? false, termos: quaisTermos.get(arquivo) ?? [] }))
    .sort((a, b) => b.score - a.score || a.arquivo.localeCompare(b.arquivo))
}

// Margem mínima do top-1 sobre o top-2 pra considerar "confiante". Junto com match estrutural, é o gate
// que libera escalar pro pago no arquivo único — senão vira shortlist ou abstenção. Medido: estrutural
// no topo separou os TOP-1 certos dos enterrados.
const LIMIAR_MARGEM = 1.3

/**
 * Gate de confiança do custo: o top-1 é forte o bastante pra escalar pro pago NELE? Exige match
 * estrutural (termo no nome do arquivo/símbolo) E margem sobre o segundo. Sem isso, o chamador deve
 * usar a shortlist (top-N) ou abster — nunca pagar às cegas.
 */
export function gateConfianca(candidatos: Candidato[]): boolean {
  if (!candidatos.length || !candidatos[0].estrutural) return false
  return candidatos.length < 2 || candidatos[0].score >= candidatos[1].score * LIMIAR_MARGEM
}

/** Localiza o arquivo a partir de termos JÁ em vocabulário de código (a tradução fica no chamador, com modelo). */
export async function localizarArquivo(
  raiz: string,
  indice: Indice,
  termos: string[],
): Promise<{ candidatos: Candidato[]; confiante: boolean }> {
  const candidatos = await ranquearCandidatos(raiz, indice, termos)
  return { candidatos, confiante: gateConfianca(candidatos) }
}
