import { readdir } from "node:fs/promises"
import { indexar, type Indice, buscarPrecedente, type Precedente } from "../conhecimento"
import type { Simbolo, ArquivoSimbolos } from "../conhecimento"
import { gerarResumos, type CacheResumos, type ResumirFn, type AlvoResumo } from "../conhecimento/resumos"
import { listarFontes, type ArquivoFonte } from "../conhecimento/walk"
import { extrairEntidades, ehGenerico, perfilTermos, expandirDominio } from "../engine/marques"

const MIN_TOKEN_ENTIDADE = 4
const MAX_SEMENTES = 60
const MAX_ARQUIVOS_FOCO = 6
const MAX_TRECHOS = 6
const MAX_LINHAS_TRECHO = 60
const MAX_CHARS_PACOTE = 14_000
const MAX_PARES = 4
const MAX_MAPA = 14
const MIN_SIMBOLOS_PRA_INDICE = 2

function entidadesEspecificas(input: string): string[] {
  const todas = extrairEntidades(input)
  const especificas = todas.filter((e) => !ehGenerico(e) && e.length >= MIN_TOKEN_ENTIDADE)
  return especificas.length ? especificas : todas.filter((e) => e.length >= MIN_TOKEN_ENTIDADE)
}

function nomeCasaEntidade(nome: string, entidades: string[]): boolean {
  const low = nome.toLowerCase()
  return entidades.some((e) => low.includes(e))
}

function resolverSementes(indice: Indice, entidades: string[]): Simbolo[] {
  const out: Simbolo[] = []
  for (const arq of indice.simbolos) {
    for (const s of arq.simbolos) {
      if (nomeCasaEntidade(s.nome, entidades)) out.push(s)
      if (out.length >= MAX_SEMENTES) return out
    }
  }
  return out
}

const RE_REPO_INTERFACE = /Repository|Repositorio|Dao\b/

function ehRepoInterface(arquivo: string): boolean {
  return RE_REPO_INTERFACE.test(arquivo.split("/").pop() ?? "")
}

const RE_RUIDO_FOCO =
  /\.(tsx|jsx)$|\/gen\/|\.gen\.|\/packages\/(ui|tui|opencode|core|sdk)\/|\/test\/|\/tests\/|\/__tests__\/|\.test\.|\.spec\.|\/node_modules\//

const RE_SERVICE = /Service|Handler|Controller|UseCase|Manager|Resolver|Job|Worker|Processor/

const PESO_NOME_ARQUIVO = 3
const PESO_SERVICE = 4
const PESO_OP_NA_SEMENTE = 5
const PESO_RUIDO = -8

type FocoCand = { arquivo: string; sementes: number; opsSemente: number; nomeCasa: boolean; service: boolean; ruido: boolean }

const RE_OP_REPO = /^findFirst|^findAll|^findBy|^find[A-Z]|save|delete|update/

export type ModoFoco = "cirurgico" | "amplo"

function rankearFoco(indice: Indice, entidades: string[], modo: ModoFoco = "cirurgico"): FocoCand[] {
  const cands: FocoCand[] = []
  for (const arq of indice.simbolos) {
    if (ehRepoInterface(arq.arquivo)) continue
    const base = (arq.arquivo.split("/").pop() ?? "").toLowerCase()
    let sementes = 0
    let opsSemente = 0
    for (const s of arq.simbolos) {
      if (!nomeCasaEntidade(s.nome, entidades)) continue
      sementes++
      if (s.chama.some((c) => RE_OP_REPO.test(c))) opsSemente++
    }
    if (sementes === 0) continue
    cands.push({
      arquivo: arq.arquivo,
      sementes,
      opsSemente,
      nomeCasa: entidades.some((e) => base.includes(e)),
      service: RE_SERVICE.test(arq.arquivo.split("/").pop() ?? ""),
      ruido: RE_RUIDO_FOCO.test(arq.arquivo),
    })
  }
  return cands.sort((x, y) => scoreFoco(y, modo) - scoreFoco(x, modo))
}

function scoreFoco(c: FocoCand, modo: ModoFoco = "cirurgico"): number {
  let s = c.sementes
  if (c.nomeCasa) s += PESO_NOME_ARQUIVO
  if (c.service) s += PESO_SERVICE
  if (c.opsSemente > 0) s += PESO_OP_NA_SEMENTE

  if (c.ruido && modo === "cirurgico") s += PESO_RUIDO
  return s
}

const MIN_CORPO_METODO = 3

const MIN_LEN_CALLEE = 4

type ChamadaOp = { metodo: string; arquivo: string; linha: number; chamada: string }

function chamadasDeOperacao(indice: Indice, arquivosFoco: Set<string>): ChamadaOp[] {
  const out: ChamadaOp[] = []
  for (const arq of indice.simbolos) {
    if (!arquivosFoco.has(arq.arquivo) || ehRepoInterface(arq.arquivo)) continue
    for (const s of arq.simbolos) {
      const temCorpo = s.tipo === "metodo" || s.tipo === "funcao"
      if (!temCorpo || !s.chama.length || s.linhaFim - s.linhaInicio < MIN_CORPO_METODO) continue
      for (const chamada of s.chama) {
        if (chamada.length >= MIN_LEN_CALLEE) out.push({ metodo: s.nome, arquivo: arq.arquivo, linha: s.linhaInicio, chamada })
      }
    }
  }
  return out
}

export type ParGrafo = {
  familia: string
  entidade: string
  a: ChamadaOp
  b: ChamadaOp
  score: number
}

function sufixoComum(x: string, y: string): string {
  const a = x.toLowerCase()
  const b = y.toLowerCase()
  let i = 0
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return a.slice(a.length - i)
}

function prefixoComum(x: string, y: string): number {
  const a = x.toLowerCase()
  const b = y.toLowerCase()
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

function similaridade(x: string, y: string): number {
  const max = Math.max(x.length, y.length)
  if (!max) return 0
  return Math.min(max, prefixoComum(x, y) + sufixoComum(x, y).length) / max
}

const MIN_SIM_OPERACAO = 0.5

function pontuarPar(a: ChamadaOp, b: ChamadaOp, entidades: string[]): number {
  let s = 4
  s += Math.round(similaridade(a.metodo, b.metodo) * 4)
  s += Math.round(similaridade(a.chamada, b.chamada) * 4)
  if (entidades.some((e) => a.metodo.toLowerCase().includes(e) || b.metodo.toLowerCase().includes(e))) s += 3
  return s
}

function* combinar<T>(xs: T[]): Generator<[T, T]> {
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) yield [xs[i], xs[j]]
  }
}

export function parearPorGrafo(chamadas: ChamadaOp[], entidades: string[]): ParGrafo[] {

  const candidatos: ParGrafo[] = []
  for (const [a, b] of combinar(chamadas)) {
    if (a.arquivo !== b.arquivo || a.metodo === b.metodo || a.chamada === b.chamada) continue
    if (similaridade(a.chamada, b.chamada) < MIN_SIM_OPERACAO) continue
    const pre = prefixoComum(a.chamada, b.chamada)
    const familia = pre >= 3 ? a.chamada.slice(0, pre) : "a mesma operação"
    candidatos.push({ familia, entidade: entidades[0] ?? "", a, b, score: pontuarPar(a, b, entidades) })
  }
  candidatos.sort(
    (x, y) =>
      y.score - x.score ||
      Math.abs(y.a.chamada.length - y.b.chamada.length) - Math.abs(x.a.chamada.length - x.b.chamada.length),
  )

  const out: ParGrafo[] = []
  const usados = new Set<string>()
  for (const par of candidatos) {
    if (out.length >= MAX_PARES) break
    const chave = [`${par.a.metodo}:${par.a.chamada}`, `${par.b.metodo}:${par.b.chamada}`].sort().join("|")
    if (usados.has(chave)) continue
    usados.add(chave)
    out.push(par)
  }
  return out
}

const GUARDAS: { nome: string; re: RegExp }[] = [
  { nome: "try/catch", re: /\b(try|catch|rescue|except|finally)\b/i },
  { nome: "transação", re: /transaction|transactional|\brollback\b|\bcommit\b/i },
  { nome: "checagem-nulo", re: /[!=]==?\s*(null|undefined|none|nil)\b|\bis(null|empty|blank|present)\b|\boptional\b|\?\./i },
  { nome: "dedupe/idempotência", re: /\b(exists|already|duplicate|idempot\w*|dedup\w*|processed|seen)\b/i },
  { nome: "lock", re: /\b(lock|synchronized|mutex|semaphore)\b/i },
]

function featuresGuarda(corpo: string): Set<string> {
  const f = new Set<string>()
  for (const g of GUARDAS) if (g.re.test(corpo)) f.add(g.nome)
  return f
}

const RE_CATCH = /\bcatch\b|\bexcept\b|\brescue\b/i
const RE_RELANCA = /\b(throw|raise|rethrow)\b/i

const RE_WRITE_CALLEE = /^(save|persist|insert|update|delete|upsert|store|merge|flush|write)/i

export function engoleEmVoltaDeWrite(corpo: string, callees: string[]): boolean {
  if (!RE_CATCH.test(corpo)) return false
  if (!callees.some((c) => RE_WRITE_CALLEE.test(c))) return false
  const i = corpo.search(RE_CATCH)
  const handler = i >= 0 ? corpo.slice(i) : corpo
  return !RE_RELANCA.test(handler)
}

const LINHAS_ANOTACAO = 3

async function parearPorGuarda(
  raiz: string,
  indice: Indice,
  foco: Set<string>,
  entidades: string[],
): Promise<ParGrafo[]> {
  type M = { metodo: string; linha: number; callees: string[]; features: Set<string>; engoleWrite: boolean }
  const candidatos: ParGrafo[] = []
  for (const arq of indice.simbolos) {
    if (!foco.has(arq.arquivo) || ehRepoInterface(arq.arquivo)) continue
    let linhas: string[]
    try {
      linhas = (await Bun.file(`${raiz}/${arq.arquivo}`).text()).split("\n")
    } catch {
      continue
    }
    const metodos: M[] = []
    for (const s of arq.simbolos) {
      if ((s.tipo !== "metodo" && s.tipo !== "funcao") || s.linhaFim - s.linhaInicio < MIN_CORPO_METODO) continue
      const ini = Math.max(0, s.linhaInicio - 1 - LINHAS_ANOTACAO)
      const corpo = linhas.slice(ini, s.linhaFim).join("\n")
      metodos.push({
        metodo: s.nome,
        linha: s.linhaInicio,
        callees: s.chama,
        features: featuresGuarda(corpo),
        engoleWrite: engoleEmVoltaDeWrite(corpo, s.chama),
      })
    }
    for (const [a, b] of combinar(metodos)) {
      const comum = a.callees.find((c) => c.length >= MIN_LEN_CALLEE && b.callees.includes(c))
      if (!comum) continue
      const diff = [...a.features].filter((x) => !b.features.has(x)).concat([...b.features].filter((x) => !a.features.has(x)))

      const engoleDiverge = a.engoleWrite !== b.engoleWrite
      if (!engoleDiverge && !diff.length) continue
      let score = 4 + diff.length * 2 + Math.round(similaridade(a.metodo, b.metodo) * 2)
      if (engoleDiverge) score += 6
      if (entidades.some((e) => a.metodo.toLowerCase().includes(e) || b.metodo.toLowerCase().includes(e))) score += 3
      candidatos.push({
        familia: engoleDiverge ? "guarda (um engole o erro de uma escrita, o outro não)" : `guarda (${diff.join(", ")})`,
        entidade: entidades[0] ?? "",
        a: { metodo: a.metodo, arquivo: arq.arquivo, linha: a.linha, chamada: comum },
        b: { metodo: b.metodo, arquivo: arq.arquivo, linha: b.linha, chamada: comum },
        score,
      })
    }
  }
  return candidatos.sort((x, y) => y.score - x.score).slice(0, MAX_PARES)
}

function renderPares(pares: ParGrafo[], rotulo: string): string {
  if (!pares.length) return ""
  const arq = (a: ChamadaOp) => a.arquivo.split("/").pop() ?? a.arquivo
  const blocos = pares.map((p, i) => {
    const a = p.a
    const b = p.b
    return (
      `CAMINHOS SOBRE "${rotulo}" via ${p.familia} (compare ${i === 0 ? "ESTE primeiro" : "também"}):\n` +
      `  [A] ${a.metodo} (${arq(a)}:${a.linha}) -> ${a.chamada}()\n` +
      `  [B] ${b.metodo} (${arq(b)}:${b.linha}) -> ${b.chamada}()\n` +
      `  PERGUNTA: ambos lidam com "${rotulo}". Por que [A] e [B] divergem? Qual causa o sintoma?`
    )
  })
  return `COMPARAÇÃO PAREADA (vinda do índice/grafo — analise, NÃO busque mais):\n\n${blocos.join("\n\n")}`
}

type Trecho = { arquivo: string; metodo: string; inicio: number; fim: number; corpo: string }

async function extrairTrechos(
  raiz: string,
  alvos: { arquivo: string; metodo: string; inicio: number; fim: number }[],
): Promise<Trecho[]> {
  const vistos = new Set<string>()
  const out: Trecho[] = []
  let chars = 0
  for (const alvo of alvos) {
    if (out.length >= MAX_TRECHOS || chars >= MAX_CHARS_PACOTE) break
    const chave = `${alvo.arquivo}#${alvo.metodo}:${alvo.inicio}`
    if (vistos.has(chave)) continue
    vistos.add(chave)
    try {
      const f = Bun.file(`${raiz}/${alvo.arquivo}`)
      if (!(await f.exists())) continue
      const linhas = (await f.text()).split("\n")
      const ini = Math.max(1, alvo.inicio)
      const fim = Math.min(linhas.length, alvo.fim - 1, ini + MAX_LINHAS_TRECHO - 1)
      const corpo = linhas
        .slice(ini - 1, fim)
        .map((l, i) => `${ini + i}\t${l}`)
        .join("\n")
      chars += corpo.length
      out.push({ arquivo: alvo.arquivo, metodo: alvo.metodo, inicio: ini, fim, corpo })
    } catch {

    }
  }
  return out
}

function renderTrechos(trechos: Trecho[]): string {
  if (!trechos.length) return ""
  const blocos = trechos.map((t) => `### ${t.arquivo}:${t.inicio} — ${t.metodo}()\n${t.corpo}`)
  return `TRECHOS CIRÚRGICOS (corpos dos métodos do par + vizinhança causal):\n\n${blocos.join("\n\n")}`
}

function renderMapa(simbolos: Simbolo[], resumos: CacheResumos): string {
  if (!simbolos.length) return ""
  const vistos = new Set<string>()
  const arquivosVistos = new Set<string>()
  const linhas: string[] = []
  for (const s of simbolos) {
    if (linhas.length >= MAX_MAPA) break
    const chave = `${s.arquivo}#${s.nome}`
    if (vistos.has(chave)) continue
    vistos.add(chave)
    const resumo = s.assinatura || `${s.tipo} ${s.nome}`
    let linha = `- ${s.arquivo}:${s.linhaInicio}  ${resumo}`
    if (!arquivosVistos.has(s.arquivo)) {
      arquivosVistos.add(s.arquivo)
      const r = resumos[s.arquivo]?.resumo
      if (r) linha += `\n    (${s.arquivo}: ${r})`
    }
    linhas.push(linha)
  }
  return `MAPA (símbolos relevantes ao sintoma):\n${linhas.join("\n")}`
}

async function alvosResumo(raiz: string, arquivos: string[]): Promise<AlvoResumo[]> {
  const out: AlvoResumo[] = []
  for (const arquivo of arquivos) {
    try {
      const conteudo = await Bun.file(`${raiz}/${arquivo}`).text()
      out.push({ arquivo, hash: Bun.hash(conteudo).toString(16), conteudo })
    } catch {

    }
  }
  return out
}

function renderPrecedentes(precedentes: Precedente[]): string {
  if (!precedentes.length) return ""
  const blocos = precedentes.map((p) => {
    if (p.tipo === "bug") {
      const b = p.item
      return `- [bug já resolvido] ${b.sintoma}\n  causa: ${b.causaRaiz} (${b.arquivoLinha})\n  correção: ${b.correcao}`
    }
    const d = p.item
    return `- [decisão] ${d.titulo}: ${d.decisao}`
  })
  return `PRECEDENTES (da memória — pode ser o mesmo bug de antes):\n${blocos.join("\n")}`
}

export type PacoteContexto = {
  entidades: string[]
  simbolosCasados: number
  arquivosFoco: string[]
  pares: ParGrafo[]
  trechos: { arquivo: string; metodo: string; linha: number }[]
  precedentes: Precedente[]
  texto: string
  forte: boolean

  escopado: boolean
}

const MAX_ARQ_SUPERFICIE = 32
const MAX_LINHAS_SUPERFICIE = 90
const MAX_CHARS_SUPERFICIE = 24_000
const MIN_TOKEN_ESCOPO = 3
const MIN_ANALOGOS_CROSS = 3

function analogosCompartilhados(fontes: ArquivoFonte[], a: string, b: string): number {
  const bn = (st: string) =>
    new Set(fontes.filter((f) => f.caminho.startsWith(`${st}/`)).map((f) => basenameSemExt(f.caminho)))
  const bnA = bn(a)
  const bnB = bn(b)
  let n = 0
  for (const x of bnA) if (bnB.has(x)) n++
  return n
}

const RE_ARQUIVO_PRIORITARIO = /\b(config|settings|client|http|base|index|resources?|api|connection|conn|setup|constants|main)\b|__init__/i
const RE_ARQUIVO_TESTE = /test|spec|__tests__|\.test\.|\.spec\./i

function prioridadeArquivo(caminho: string): number {
  const base = caminho.split("/").pop() ?? ""
  let p = 0
  if (RE_ARQUIVO_PRIORITARIO.test(base)) p += 10
  if (RE_ARQUIVO_TESTE.test(caminho)) p -= 20
  return p
}

function basenameSemExt(caminho: string): string {
  const base = caminho.split("/").pop() ?? caminho
  const i = base.lastIndexOf(".")
  return (i > 0 ? base.slice(0, i) : base).toLowerCase()
}

export async function escoposCitados(raiz: string, input: string, fontes: ArquivoFonte[]): Promise<string[]> {
  const baixo = input.toLowerCase()
  const tokens = [...new Set(extrairEntidades(input).map((t) => t.toLowerCase()).filter((t) => t.length >= MIN_TOKEN_ESCOPO))]
  if (!tokens.length) return []

  const subtrees = new Set<string>()
  for (const f of fontes) {
    const segs = f.caminho.split("/")
    if (segs.length >= 2) subtrees.add(segs[0])
    if (segs.length >= 3) subtrees.add(`${segs[0]}/${segs[1]}`)
  }

  const cands: { st: string; score: number; pos: number }[] = []
  for (const st of subtrees) {
    const segs = st.toLowerCase().split(/[/\-_.]/).filter((s) => s.length >= 3)
    let score = 0
    let pos = Infinity
    for (const tok of tokens) {

      if (segs.some((s) => s.includes(tok))) {
        score++
        pos = Math.min(pos, baixo.indexOf(tok))
      }
    }
    if (score > 0) cands.push({ st, score, pos })
  }
  if (!cands.length) return []

  cands.sort((a, b) => b.score - a.score || a.st.length - b.st.length || a.pos - b.pos)

  const escolhidos: { st: string; pos: number }[] = []
  for (const c of cands) {
    if (escolhidos.some((e) => c.st.startsWith(`${e.st}/`) || e.st.startsWith(`${c.st}/`))) continue
    escolhidos.push({ st: c.st, pos: c.pos })
    if (escolhidos.length >= 2) break
  }
  const ordenados = escolhidos.sort((a, b) => a.pos - b.pos).map((e) => e.st)

  if (ordenados.length === 2 && analogosCompartilhados(fontes, ordenados[0], ordenados[1]) < MIN_ANALOGOS_CROSS) {
    return [ordenados[0]]
  }
  return ordenados
}

async function manifestosDaRaiz(raiz: string, st: string): Promise<string[]> {
  try {
    const entradas = await readdir(`${raiz}/${st}`, { withFileTypes: true })
    return entradas.filter((e) => e.isFile()).map((e) => `${st}/${e.name}`)
  } catch {
    return []
  }
}

async function superficieEscopada(
  raiz: string,
  subtrees: string[],
  fontes: ArquivoFonte[],
  input: string,
): Promise<{ texto: string; arquivos: string[] } | null> {
  const grupos = subtrees
    .map((st) => ({ st, arqs: fontes.filter((f) => f.caminho === st || f.caminho.startsWith(`${st}/`)) }))
    .filter((g) => g.arqs.length)
  if (!grupos.length) return null

  const tokens = [...new Set(extrairEntidades(input).map((t) => t.toLowerCase()).filter((t) => t.length >= 3))]

  const bonusToken = (caminho: string) => (tokens.some((t) => basenameSemExt(caminho).includes(t)) ? 15 : 0)

  const cross = grupos.length >= 2
  const contagem = new Map<string, number>()
  if (cross) {
    for (const g of grupos) {
      for (const bn of new Set(g.arqs.map((a) => basenameSemExt(a.caminho)))) {
        contagem.set(bn, (contagem.get(bn) ?? 0) + 1)
      }
    }
  }
  const bonusAnalogo = (caminho: string) => ((contagem.get(basenameSemExt(caminho)) ?? 0) >= 2 ? 30 : 0)

  const score = (caminho: string, manifesto: boolean) =>
    (manifesto ? 8 : prioridadeArquivo(caminho)) + bonusToken(caminho) + bonusAnalogo(caminho)

  const blocos: string[] = []
  const arquivos: string[] = []
  const vistos = new Set<string>()
  let chars = 0
  const capPorGrupo = Math.floor(MAX_CHARS_SUPERFICIE / grupos.length)

  for (const g of grupos) {
    const manifestos = (await manifestosDaRaiz(raiz, g.st)).map((caminho) => ({ caminho, manifesto: true }))
    const fontesC = g.arqs.map((a) => ({ caminho: a.caminho, manifesto: false }))
    const ordenados = [...manifestos, ...fontesC]
      .sort((a, b) => score(b.caminho, b.manifesto) - score(a.caminho, a.manifesto))
      .slice(0, MAX_ARQ_SUPERFICIE)
    if (cross) blocos.push(`===== ${g.st} =====`)
    let charsGrupo = 0
    for (const { caminho } of ordenados) {
      if (chars >= MAX_CHARS_SUPERFICIE || charsGrupo >= capPorGrupo) break
      if (vistos.has(caminho)) continue
      vistos.add(caminho)
      try {
        const linhas = (await Bun.file(`${raiz}/${caminho}`).text()).split("\n").slice(0, MAX_LINHAS_SUPERFICIE)
        const numeradas = linhas.map((l, i) => `${i + 1}\t${l}`).join("\n")
        blocos.push(`### ${caminho}\n${numeradas}`)
        arquivos.push(caminho)
        chars += numeradas.length
        charsGrupo += numeradas.length
      } catch {

      }
    }
  }
  if (!arquivos.length) return null
  const cab = cross
    ? "COMPARE os dois ecossistemas abaixo — um funciona, o outro tem o bug. O ponto onde DIVERGEM é a causa. Aponte arquivo:linha:"
    : "CÓDIGO ESCOPADO (o ponto do sintoma ESTÁ aqui dentro — escaneie e aponte arquivo:linha):"
  return { texto: `${cab}\n\n${blocos.join("\n\n")}`, arquivos }
}

function simbolosDoMapa(indice: Indice, sementes: Simbolo[], pares: ParGrafo[], foco: Set<string>): Simbolo[] {
  const porChave = new Map<string, Simbolo>()
  const add = (s: Simbolo) => porChave.set(`${s.arquivo}#${s.nome}`, s)
  for (const arq of indice.simbolos) {
    for (const s of arq.simbolos) {
      if (pares.some((p) => igualLado(s, arq.arquivo, p))) add(s)
    }
  }
  for (const s of sementes) if (foco.has(s.arquivo)) add(s)
  return [...porChave.values()]
}

function igualLado(s: Simbolo, arquivo: string, p: ParGrafo): boolean {
  return (s.nome === p.a.metodo && arquivo === p.a.arquivo) || (s.nome === p.b.metodo && arquivo === p.b.arquivo)
}

function alvosDeTrecho(
  indice: Indice,
  sementes: Simbolo[],
  pares: ParGrafo[],
  foco: Set<string>,
): { arquivo: string; metodo: string; inicio: number; fim: number }[] {
  const alvos: { arquivo: string; metodo: string; inicio: number; fim: number }[] = []
  const buscar = (arquivo: string, metodo: string): Simbolo | undefined =>
    indice.simbolos.find((a) => a.arquivo === arquivo)?.simbolos.find((s) => s.nome === metodo)
  for (const p of pares) {
    for (const lado of [p.a, p.b]) {
      const sim = buscar(lado.arquivo, lado.metodo)
      if (sim) alvos.push({ arquivo: sim.arquivo, metodo: sim.nome, inicio: sim.linhaInicio, fim: sim.linhaFim })
    }
  }
  for (const s of sementes) {
    if (foco.has(s.arquivo)) alvos.push({ arquivo: s.arquivo, metodo: s.nome, inicio: s.linhaInicio, fim: s.linhaFim })
  }
  return alvos
}

const MAX_FOCO_TERMOS = 6

function textoIndexadoDoArquivo(a: ArquivoSimbolos): string {
  const simbolos = a.simbolos.map((s) => `${s.nome} ${s.assinatura}`).join(" ")
  return `${a.arquivo.replace(/[/.]/g, " ")} ${simbolos}`
}

function rankearPorTermos(indice: Indice, input: string): { arquivo: string; score: number }[] {
  const vocab = new Set<string>()
  const perfis = indice.simbolos.map((a) => {

    const conteudo = indice.termos[a.arquivo]
    const perfil = conteudo?.length ? new Map(conteudo) : perfilTermos(textoIndexadoDoArquivo(a))
    for (const k of perfil.keys()) vocab.add(k)
    return { arquivo: a.arquivo, perfil }
  })

  const tokens = [...new Set([...perfilTermos(input).keys(), ...extrairEntidades(input)])]
  const q = expandirDominio(tokens, vocab).filter((t) => t.length >= MIN_TOKEN_ESCOPO)
  if (!q.length) return []

  const out: { arquivo: string; score: number }[] = []
  for (const { arquivo, perfil } of perfis) {
    let score = 0
    for (const t of q) {
      for (const [termo, f] of perfil) {
        if (termo === t || termo.includes(t) || t.includes(termo)) {
          score += f
          break
        }
      }
    }
    if (score <= 0) continue
    if (RE_RUIDO_FOCO.test(arquivo)) score -= 3
    out.push({ arquivo, score })
  }
  return out.sort((x, y) => y.score - x.score)
}

export async function superficieDeArquivos(
  raiz: string,
  arquivos: string[],
): Promise<{ texto: string; arquivos: string[] } | null> {
  const blocos: string[] = []
  const usados: string[] = []
  let chars = 0
  for (const caminho of arquivos.slice(0, MAX_ARQ_SUPERFICIE)) {
    if (chars >= MAX_CHARS_SUPERFICIE) break
    try {
      const linhas = (await Bun.file(`${raiz}/${caminho}`).text()).split("\n").slice(0, MAX_LINHAS_SUPERFICIE)
      const numeradas = linhas.map((l, i) => `${i + 1}\t${l}`).join("\n")
      blocos.push(`### ${caminho}\n${numeradas}`)
      usados.push(caminho)
      chars += numeradas.length
    } catch {

    }
  }
  if (!usados.length) return null
  return {
    texto: `CÓDIGO RELEVANTE (selecionado por frequência de termos — o ponto do sintoma ESTÁ aqui, aponte arquivo:linha):\n\n${blocos.join("\n\n")}`,
    arquivos: usados,
  }
}

export async function montarPacote(
  raiz: string,
  input: string,
  resumir: ResumirFn | null = null,
): Promise<PacoteContexto> {
  const entidades = entidadesEspecificas(input)
  const indice = await indexar(raiz)
  const precedentes = await buscarPrecedente(raiz, input)

  if (!entidades.length) {
    return pacoteFraco(entidades, precedentes)
  }

  const fontes = await listarFontes(raiz)
  const subtrees = await escoposCitados(raiz, input, fontes)
  const noEscopo = (arquivo: string) =>
    subtrees.length === 0 || subtrees.some((st) => arquivo === st || arquivo.startsWith(`${st}/`))

  const sementes = resolverSementes(indice, entidades).filter((s) => noEscopo(s.arquivo))

  let focoLista = rankearFoco(indice, entidades)
    .filter((c) => noEscopo(c.arquivo))
    .slice(0, MAX_ARQUIVOS_FOCO)
    .map((c) => c.arquivo)

  if (!focoLista.length && subtrees.length === 0) {
    focoLista = rankearPorTermos(indice, input)
      .filter((r) => noEscopo(r.arquivo))
      .slice(0, MAX_FOCO_TERMOS)
      .map((r) => r.arquivo)
  }
  const foco = new Set(focoLista)

  const chamadas = chamadasDeOperacao(indice, foco)
  const paresChamada = parearPorGrafo(chamadas, entidades)

  const paresGuarda = await parearPorGuarda(raiz, indice, foco, entidades)
  const pares: ParGrafo[] = []
  const vistosPar = new Set<string>()
  for (const p of [...paresChamada, ...paresGuarda].sort((x, y) => y.score - x.score)) {
    const k = [p.a.metodo, p.b.metodo].sort().join("|")
    if (vistosPar.has(k)) continue
    vistosPar.add(k)
    pares.push(p)
    if (pares.length >= MAX_PARES) break
  }

  if (pares.length === 0 && subtrees.length > 0) {
    const sup = await superficieEscopada(raiz, subtrees, fontes, input)
    if (sup) {
      return {
        entidades,
        simbolosCasados: sementes.length,
        arquivosFoco: sup.arquivos,
        pares: [],
        trechos: [],
        precedentes,
        texto: sup.texto,
        forte: true,
        escopado: true,
      }
    }
  }

  if (pares.length === 0 && focoLista.length > 0) {
    const sup = await superficieDeArquivos(raiz, focoLista)
    if (sup) {
      return {
        entidades,
        simbolosCasados: sementes.length,
        arquivosFoco: sup.arquivos,
        pares: [],
        trechos: [],
        precedentes,
        texto: sup.texto,
        forte: true,
        escopado: true,
      }
    }
  }

  const rotulo = entidades[0] ?? "a entidade"
  const mapaSimbolos = simbolosDoMapa(indice, sementes, pares, foco)

  const resumos = await gerarResumos(raiz, await alvosResumo(raiz, focoLista), resumir)
  const trechos = await extrairTrechos(raiz, alvosDeTrecho(indice, sementes, pares, foco))

  const blocos = [
    renderMapa(mapaSimbolos, resumos),
    renderPares(pares, rotulo),
    renderTrechos(trechos),
    renderPrecedentes(precedentes),
  ].filter(Boolean)

  const texto = blocos.join("\n\n").slice(0, MAX_CHARS_PACOTE)

  const forte = pares.length > 0 || (sementes.length >= MIN_SIMBOLOS_PRA_INDICE && trechos.length > 0)

  return {
    entidades,
    simbolosCasados: sementes.length,
    arquivosFoco: focoLista,
    pares,
    trechos: trechos.map((t) => ({ arquivo: t.arquivo, metodo: t.metodo, linha: t.inicio })),
    precedentes,
    texto,
    forte,
    escopado: false,
  }
}

function pacoteFraco(entidades: string[], precedentes: Precedente[]): PacoteContexto {
  const texto = renderPrecedentes(precedentes)
  return {
    entidades,
    simbolosCasados: 0,
    arquivosFoco: [],
    pares: [],
    trechos: [],
    precedentes,
    texto,
    forte: false,
    escopado: false,
  }
}

const MAX_ARQUIVOS_AMPLO = 20
const MAX_SIMBOLOS_POR_ARQ = 6

export type MapaAmplo = { texto: string; arquivos: string[] }

function arquivosCentrais(indice: Indice): string[] {
  return [...indice.simbolos]
    .filter((a) => a.simbolos.length > 0)
    .sort((x, y) => y.simbolos.length - x.simbolos.length)
    .map((a) => a.arquivo)
}

export async function montarMapaAmplo(
  raiz: string,
  input: string,
  resumir: ResumirFn | null = null,
): Promise<MapaAmplo> {
  const indice = await indexar(raiz)
  const entidades = extrairEntidades(input)
  const ranqueados = entidades.length ? rankearFoco(indice, entidades, "amplo").map((c) => c.arquivo) : []
  const arquivos = (ranqueados.length ? ranqueados : arquivosCentrais(indice)).slice(0, MAX_ARQUIVOS_AMPLO)
  const resumos = await gerarResumos(raiz, await alvosResumo(raiz, arquivos), resumir)

  const blocos: string[] = []
  for (const arq of arquivos) {
    const def = indice.simbolos.find((a) => a.arquivo === arq)
    if (!def) continue
    const r = resumos[arq]?.resumo
    const cab = r ? `### ${arq} — ${r}` : `### ${arq}`
    const simbolos = def.simbolos
      .slice(0, MAX_SIMBOLOS_POR_ARQ)
      .map((s) => `  ${s.linhaInicio}: ${s.assinatura || `${s.tipo} ${s.nome}`}`)
    blocos.push([cab, ...simbolos].join("\n"))
  }
  const texto = blocos.length
    ? `MAPA DO PROJETO (arquivos relevantes — assinaturas + resumo de 1 linha):\n\n${blocos.join("\n\n")}`
    : ""
  return { texto, arquivos }
}
