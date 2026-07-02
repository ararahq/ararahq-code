import { statSync } from "node:fs"
import type { Indice } from "../conhecimento"
import type { Simbolo } from "../conhecimento"
import { perfilTermos, extrairEntidades, ehGenerico } from "../engine/marques"

const MAX_JANELA_LER = 160
const MAX_HITS_GREP = 30
const MAX_TERMOS_BUSCA = 8
const HOPS_PADRAO = 2

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

export function limparCacheConteudo(): void {
  cacheConteudo.clear()
}

export function arquivoDoNo(id: string): string {
  const corpo = id.slice(2)
  const cerquilha = corpo.indexOf("#")
  return cerquilha >= 0 ? corpo.slice(0, cerquilha) : corpo
}

export function entrypoints(indice: Indice, n = 12): { arquivo: string; grau: number }[] {
  const defs = defsPorNome(indice)
  const grau = new Map<string, number>()
  const bump = (arq: string) => grau.set(arq, (grau.get(arq) ?? 0) + 1)

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

export function listar(indice: Indice, prefixo = "", max = 60): string[] {
  return indice.simbolos
    .map((s) => s.arquivo)
    .filter((a) => a.startsWith(prefixo))
    .sort()
    .slice(0, max)
}

export function simbolosDe(indice: Indice, arquivo: string): Simbolo[] {
  return indice.simbolos.find((s) => s.arquivo === arquivo)?.simbolos ?? []
}

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

export async function explorar(
  raiz: string,
  indice: Indice,
  input: string,
  opts: { K?: number; hops?: number; termos?: string[] } = {},
): Promise<Alcance[]> {
  const K = opts.K ?? MAX_TERMOS_BUSCA
  const hops = opts.hops ?? HOPS_PADRAO

  const termos = opts.termos ?? termosDeBusca(input)
  const alcancados = new Map<string, { via: string; passo: number }>()
  let passo = 0

  for (const t of termos) {
    if (passo >= K) break
    passo++
    for (const h of await grep(raiz, indice, t, MAX_HITS_GREP)) {
      if (!alcancados.has(h.arquivo)) alcancados.set(h.arquivo, { via: `grep:${t}`, passo })
    }
  }

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

function reTermo(termo: string): RegExp {
  return new RegExp(`\\b${termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")
}

function casaEstrutura(termo: string, arquivo: string, indice: Indice): boolean {
  const t = termo.toLowerCase()
  if (arquivo.toLowerCase().includes(t)) return true
  return simbolosDe(indice, arquivo).some((s) => s.nome.toLowerCase().includes(t))
}

export type Candidato = { arquivo: string; score: number; estrutural: boolean; termos: string[] }

export async function ranquearCandidatos(raiz: string, indice: Indice, termos: string[]): Promise<Candidato[]> {
  if (!termos.length) return []
  const res = termos.map(reTermo)
  const casados = new Map<string, number[]>()
  const df = Array.from({ length: termos.length }, () => 0)

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

const LIMIAR_MARGEM = 1.3

export function gateConfianca(candidatos: Candidato[]): boolean {
  if (!candidatos.length || !candidatos[0].estrutural) return false
  return candidatos.length < 2 || candidatos[0].score >= candidatos[1].score * LIMIAR_MARGEM
}

export async function localizarArquivo(
  raiz: string,
  indice: Indice,
  termos: string[],
): Promise<{ candidatos: Candidato[]; confiante: boolean }> {
  const candidatos = await ranquearCandidatos(raiz, indice, termos)
  return { candidatos, confiante: gateConfianca(candidatos) }
}
