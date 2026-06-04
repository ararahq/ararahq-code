import { lerJson, gravarJson } from "./armazenamento"
import { extrairEntidades } from "../engine/marques"

const ARQUIVO = "memoria.json"

export type Bug = {
  id: string
  sintoma: string
  causaRaiz: string
  arquivoLinha: string
  correcao: string
  ts: string
}

export type Decisao = {
  id: string
  titulo: string
  contexto: string
  decisao: string
  ts: string
}

export type Padrao = {
  id: string
  nome: string
  descricao: string
  ts: string
}

export type Memoria = { decisoes: Decisao[]; bugs: Bug[]; padroes: Padrao[] }

export type Precedente =
  | { tipo: "bug"; score: number; item: Bug }
  | { tipo: "decisao"; score: number; item: Decisao }

const VAZIA: Memoria = { decisoes: [], bugs: [], padroes: [] }
const MAX_ITENS = 500

function novoId(prefixo: string): string {
  return `${prefixo}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export async function carregarMemoria(raiz: string): Promise<Memoria> {
  const m = await lerJson<Partial<Memoria>>(raiz, ARQUIVO, VAZIA)
  return { decisoes: m.decisoes ?? [], bugs: m.bugs ?? [], padroes: m.padroes ?? [] }
}

async function salvar(raiz: string, m: Memoria): Promise<void> {
  m.bugs = m.bugs.slice(-MAX_ITENS)
  m.decisoes = m.decisoes.slice(-MAX_ITENS)
  m.padroes = m.padroes.slice(-MAX_ITENS)
  await gravarJson(raiz, ARQUIVO, m)
}

/** Registra um bug resolvido (sintoma -> causa raiz -> arquivo:linha -> correção). Persiste acumulando. */
export async function registrarBug(
  raiz: string,
  dados: { sintoma: string; causaRaiz: string; arquivoLinha: string; correcao: string },
): Promise<Bug> {
  const m = await carregarMemoria(raiz)
  const bug: Bug = { id: novoId("bug"), ts: new Date().toISOString(), ...dados }
  m.bugs.push(bug)
  await salvar(raiz, m)
  return bug
}

/** Registra uma decisão de arquitetura/projeto. Persiste acumulando entre sessões. */
export async function registrarDecisao(
  raiz: string,
  dados: { titulo: string; contexto: string; decisao: string },
): Promise<Decisao> {
  const m = await carregarMemoria(raiz)
  const dec: Decisao = { id: novoId("dec"), ts: new Date().toISOString(), ...dados }
  m.decisoes.push(dec)
  await salvar(raiz, m)
  return dec
}

/** Registra um padrão recorrente do codebase (convenção, idiom, armadilha). */
export async function registrarPadrao(
  raiz: string,
  dados: { nome: string; descricao: string },
): Promise<Padrao> {
  const m = await carregarMemoria(raiz)
  const p: Padrao = { id: novoId("pad"), ts: new Date().toISOString(), ...dados }
  m.padroes.push(p)
  await salvar(raiz, m)
  return p
}

function termos(texto: string): Set<string> {
  return new Set(extrairEntidades(texto))
}

/** Similaridade por overlap de termos (Jaccard) entre o sintoma da query e o de um precedente. */
function similaridade(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

const MIN_SCORE = 0.05
const MAX_RESULTADOS = 5

/**
 * Recupera precedentes (bugs e decisões) por similaridade de termos com o sintoma dado (1.5).
 * Reusa `extrairEntidades` (tokenização PT->EN + camelCase) pra casar mesmo com fraseado diferente.
 * Bug casa contra sintoma+causaRaiz+correção; decisão contra título+contexto+decisão. Ordenado desc.
 */
export async function buscarPrecedente(raiz: string, sintoma: string): Promise<Precedente[]> {
  const m = await carregarMemoria(raiz)
  const alvo = termos(sintoma)
  if (!alvo.size) return []

  const resultados: Precedente[] = []
  for (const bug of m.bugs) {
    const score = similaridade(alvo, termos(`${bug.sintoma} ${bug.causaRaiz} ${bug.correcao}`))
    if (score >= MIN_SCORE) resultados.push({ tipo: "bug", score, item: bug })
  }
  for (const dec of m.decisoes) {
    const score = similaridade(alvo, termos(`${dec.titulo} ${dec.contexto} ${dec.decisao}`))
    if (score >= MIN_SCORE) resultados.push({ tipo: "decisao", score, item: dec })
  }
  return resultados.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTADOS)
}
