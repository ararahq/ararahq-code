import { indexar, type Indice, buscarPrecedente, type Precedente } from "../conhecimento"
import type { Simbolo } from "../conhecimento"
import { extrairEntidades, ehGenerico } from "../engine/marques"

// Camada 2 — Montagem de Contexto (determinística, via índice da Camada 1).
//
// Substitui o gather por GREP do diagnóstico por um gather por ÍNDICE/GRAFO. Entidades do sintoma
// resolvem a símbolos-semente pelo índice reverso; o grafo (campo `chama` já materializado) acha os
// métodos que operam sobre a MESMA família de repositório e os pareia quando divergem na chamada
// específica. O modelo de raciocínio recebe um PACOTE preciso: MAPA + TRECHOS CIRÚRGICOS (corpos dos
// métodos, não arquivos inteiros) + COMPARAÇÃO PAREADA (vinda do grafo) + PRECEDENTES da memória.
//
// 2.4 (subagente de busca com janela LLM separada) está ADIADO: o índice determinístico cobre a
// maior parte do ganho. Quando o índice vier fraco, o caminho degrada pro gather antigo por grep.

const MIN_TOKEN_ENTIDADE = 4
const MAX_SEMENTES = 60
const MAX_ARQUIVOS_FOCO = 6
const MAX_TRECHOS = 6
const MAX_LINHAS_TRECHO = 60
const MAX_CHARS_PACOTE = 14_000
const MAX_PARES = 4
const MAX_MAPA = 14
const MIN_SIMBOLOS_PRA_INDICE = 2

/** Termos distintivos do sintoma (sem genéricos como number/message). Caem pro conjunto cru se vazio. */
function entidadesEspecificas(input: string): string[] {
  const todas = extrairEntidades(input)
  const especificas = todas.filter((e) => !ehGenerico(e) && e.length >= MIN_TOKEN_ENTIDADE)
  return especificas.length ? especificas : todas.filter((e) => e.length >= MIN_TOKEN_ENTIDADE)
}

/** Um nome de símbolo casa a entidade se a contém como substring (isShared casa "shared"). */
function nomeCasaEntidade(nome: string, entidades: string[]): boolean {
  const low = nome.toLowerCase()
  return entidades.some((e) => low.includes(e))
}

/**
 * Símbolos-semente: definições cujo NOME casa um termo do sintoma (via índice, não grep). Pega
 * assignSharedNumber/isSharedNumber/findByDedicated... O nome que não cita a entidade (resolveSender)
 * entra depois, pela expansão do grafo no mesmo arquivo.
 */
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

/** Arquivo de interface de repositório (Spring Data): só declarações sem corpo — pareá-las dá ruído. */
function ehRepoInterface(arquivo: string): boolean {
  return RE_REPO_INTERFACE.test(arquivo.split("/").pop() ?? "")
}

// Sinais de RUÍDO num monorepo: o sintoma de domínio casa nomes em UI, código gerado, SDK e teste —
// que NÃO são o ponto onde a operação acontece. Afunda esses no ranking do foco.
const RE_RUIDO_FOCO =
  /\.(tsx|jsx)$|\/gen\/|\.gen\.|\/packages\/(ui|tui|opencode|core|sdk)\/|\/test\/|\/tests\/|\/__tests__\/|\.test\.|\.spec\.|\/node_modules\//
// Arquivo onde a lógica de domínio vive (service/handler/controller): é onde a operação diverge.
const RE_SERVICE = /Service|Handler|Controller|UseCase|Manager|Resolver|Job|Worker|Processor/

const PESO_NOME_ARQUIVO = 3
const PESO_SERVICE = 4
const PESO_OP_NA_SEMENTE = 5
const PESO_RUIDO = -8

type FocoCand = { arquivo: string; sementes: number; opsSemente: number; nomeCasa: boolean; service: boolean; ruido: boolean }

const RE_OP_REPO = /^findFirst|^findAll|^findBy|^find[A-Z]|save|delete|update/

/**
 * Rankeia os arquivos das sementes por relevância de DOMÍNIO (não por ordem de varredura). O sinal
 * forte vem do grafo: arquivo de serviço cuja semente já chama uma operação de repositório é onde a
 * divergência mora (resolveSender/assignSharedNumber). Num monorepo, contagem de nome sozinha enterra
 * o serviço backend sob telas de UI que citam "shared" — por isso o peso pesado vai pra ops+service.
 */
function rankearFoco(indice: Indice, entidades: string[]): FocoCand[] {
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
  return cands.sort((x, y) => scoreFoco(y) - scoreFoco(x))
}

function scoreFoco(c: FocoCand): number {
  let s = c.sementes
  if (c.nomeCasa) s += PESO_NOME_ARQUIVO
  if (c.service) s += PESO_SERVICE
  if (c.opsSemente > 0) s += PESO_OP_NA_SEMENTE
  if (c.ruido) s += PESO_RUIDO
  return s
}

// Famílias de operação de repositório/estado. Ordem importa: o mais específico primeiro pra que
// findFirstBy... seja rotulado "findFirst", não "find".
const FAMILIAS: { familia: string; re: RegExp }[] = [
  { familia: "findFirst", re: /^findFirst/i },
  { familia: "findAll", re: /^findAll/i },
  { familia: "findBy", re: /^findBy/i },
  { familia: "find", re: /^find[A-Z]/i },
  { familia: "save", re: /save/i },
  { familia: "delete", re: /delete/i },
  { familia: "update", re: /update/i },
]

function familiaDe(chamada: string): string | null {
  for (const { familia, re } of FAMILIAS) if (re.test(chamada)) return familia
  return null
}

const MIN_CORPO_METODO = 3

type ChamadaOp = { metodo: string; arquivo: string; linha: number; chamada: string; familia: string }

/**
 * A partir dos arquivos das sementes, coleta as chamadas de operação de repositório de TODOS os
 * métodos com corpo real desses arquivos (incluindo os que o nome não cita a entidade). É a expansão
 * pelo grafo: o campo `chama` já materializado liga método -> operação, sem reler corpo nem grep.
 */
function chamadasDeOperacao(indice: Indice, arquivosFoco: Set<string>): ChamadaOp[] {
  const out: ChamadaOp[] = []
  for (const arq of indice.simbolos) {
    if (!arquivosFoco.has(arq.arquivo) || ehRepoInterface(arq.arquivo)) continue
    for (const s of arq.simbolos) {
      const temCorpo = s.tipo === "metodo" || s.tipo === "funcao"
      if (!temCorpo || !s.chama.length || s.linhaFim - s.linhaInicio < MIN_CORPO_METODO) continue
      for (const chamada of s.chama) {
        const familia = familiaDe(chamada)
        if (familia) out.push({ metodo: s.nome, arquivo: arq.arquivo, linha: s.linhaInicio, chamada, familia })
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

/** Maior sufixo comum (case-insensitive): mede "mesma intenção de query" (ambas ...IsActiveTrue). */
function sufixoComum(x: string, y: string): string {
  const a = x.toLowerCase()
  const b = y.toLowerCase()
  let i = 0
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return a.slice(a.length - i)
}

const SUFIXO_INTENCAO = 8
const TERMOS_SHARED = ["shared", "compartilhado", "compartilhados", "compartilhada", "compartilhadas"]
const RE_POOL_SEM_DONO = /IsNull|OrganizationIsNull|OrganizationIdIsNull/i

/**
 * Score do par (a peça que faz o modelo cravar): quão forte é como "caminho A vs B do mesmo bug".
 * - intra-arquivo (mesmo serviço): base +4 (par cross-arquivo nem entra — filtrado antes).
 * - nome de algum método cita a entidade (assignSharedNumber): +3.
 * - mesma intenção de query (sufixo significativo, ex: ...IsActiveTrue): +4 — divergem SÓ no escopo.
 * - sintoma fala de "shared" e uma chamada busca o pool sem dono (OrganizationIdIsNull): +2 — desempata
 *   o caso compartilhado (pool Arara = organization null) entre as candidatas da mesma família.
 */
function pontuarPar(a: ChamadaOp, b: ChamadaOp, entidades: string[]): number {
  let s = 4
  const citaNome = (m: string) => entidades.some((e) => m.toLowerCase().includes(e))
  if (citaNome(a.metodo) || citaNome(b.metodo)) s += 3
  if (sufixoComum(a.chamada, b.chamada).length >= SUFIXO_INTENCAO) s += 4
  const temShared = entidades.some((e) => TERMOS_SHARED.includes(e))
  if (temShared && RE_POOL_SEM_DONO.test(`${a.chamada}${b.chamada}`)) s += 2
  return s
}

/** Gera todos os pares (i<j) de uma lista. */
function* combinar<T>(xs: T[]): Generator<[T, T]> {
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) yield [xs[i], xs[j]]
  }
}

/**
 * Comparação pareada por GRAFO (substitui o pareamento por regex/grep). Agrupa as chamadas de
 * operação por família e pareia, dentro do MESMO arquivo, métodos distintos que divergem na chamada
 * específica (deveriam buscar igual, mas não). Ordena por score; desempata pela diferença de
 * qualificação (genérico vs específico), que põe o par de maior contraste no topo. Determinístico,
 * sem LLM. Vazio se não há divergência clara — aí o gather degrada pro grep.
 */
export function parearPorGrafo(chamadas: ChamadaOp[], entidades: string[]): ParGrafo[] {
  const porFamilia = new Map<string, ChamadaOp[]>()
  for (const c of chamadas) {
    const lista = porFamilia.get(c.familia) ?? []
    lista.push(c)
    porFamilia.set(c.familia, lista)
  }

  const candidatos: ParGrafo[] = []
  for (const [familia, lista] of porFamilia) {
    for (const [a, b] of combinar(lista)) {
      if (a.metodo === b.metodo || a.chamada === b.chamada || a.arquivo !== b.arquivo) continue
      candidatos.push({ familia, entidade: entidades[0] ?? "", a, b, score: pontuarPar(a, b, entidades) })
    }
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

/** Renderiza os pares como bloco fechado pra injetar ANTES dos trechos no pacote da M3. */
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
      `  PERGUNTA: ambos lidam com "${rotulo}". Por que [A] e [B] divergem na chamada? Qual causa o sintoma?`
    )
  })
  return `COMPARAÇÃO PAREADA (vinda do índice/grafo — analise, NÃO busque mais):\n\n${blocos.join("\n\n")}`
}

type Trecho = { arquivo: string; metodo: string; inicio: number; fim: number; corpo: string }

/**
 * Extrai os CORPOS dos métodos relevantes (não arquivos inteiros) pelos ranges linhaInicio/linhaFim
 * do índice, com `arquivo:linha`. Prioriza os métodos que aparecem nos pares; completa com sementes.
 * Cap de linhas por trecho e de chars total pra não estourar o contexto.
 */
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
      // arquivo ilegível: ignora, segue com os demais
    }
  }
  return out
}

/** Renderiza os trechos cirúrgicos com cabeçalho arquivo:linha por método. */
function renderTrechos(trechos: Trecho[]): string {
  if (!trechos.length) return ""
  const blocos = trechos.map((t) => `### ${t.arquivo}:${t.inicio} — ${t.metodo}()\n${t.corpo}`)
  return `TRECHOS CIRÚRGICOS (corpos dos métodos do par + vizinhança causal):\n\n${blocos.join("\n\n")}`
}

/** Mapa de 1 linha por símbolo relevante (assinatura). Orienta o modelo sem despejar arquivo inteiro. */
function renderMapa(simbolos: Simbolo[]): string {
  if (!simbolos.length) return ""
  const vistos = new Set<string>()
  const linhas: string[] = []
  for (const s of simbolos) {
    if (linhas.length >= MAX_MAPA) break
    const chave = `${s.arquivo}#${s.nome}`
    if (vistos.has(chave)) continue
    vistos.add(chave)
    const resumo = s.assinatura || `${s.tipo} ${s.nome}`
    linhas.push(`- ${s.arquivo}:${s.linhaInicio}  ${resumo}`)
  }
  return `MAPA (símbolos relevantes ao sintoma):\n${linhas.join("\n")}`
}

/** Renderiza os precedentes da memória (1.5) que casam o sintoma. Vazio se não houver. */
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
}

/**
 * Símbolos do mapa: os métodos que entraram nos pares (cobre resolveSender, que o nome não cita) +
 * as sementes dos ARQUIVOS-FOCO. Sementes de UI/gen fora do foco não entram — o mapa orienta o
 * modelo pro código de domínio, não pra telas que só citam a entidade.
 */
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

/**
 * Alvos de trecho: PRIMEIRO os métodos dos pares (a vizinhança causal exata — o A vs B), depois as
 * sementes que estão nos ARQUIVOS-FOCO (relevância de domínio). Mantém os corpos cirúrgicos focados
 * no service onde a divergência mora, sem gastar orçamento com componentes de UI fora do foco.
 */
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

/**
 * Monta o pacote de contexto do diagnóstico SEM chamar LLM, via índice da Camada 1. Garante o índice
 * fresco (incremental, barato), resolve sementes pelo reverso, pareia por grafo, extrai os corpos
 * cirúrgicos e injeta precedentes da memória. `forte` indica se o índice resolveu o bastante; quando
 * fraco, quem chama degrada pro gather antigo por grep. Determinístico e reusável: o mesmo pacote
 * alimenta todos os modelos da cadeia de fallback sem recomputar I/O.
 */
export async function montarPacote(raiz: string, input: string): Promise<PacoteContexto> {
  const entidades = entidadesEspecificas(input)
  const indice = await indexar(raiz)
  const precedentes = await buscarPrecedente(raiz, input)

  if (!entidades.length) {
    return pacoteFraco(entidades, precedentes)
  }

  const sementes = resolverSementes(indice, entidades)
  // Foco rankeado por relevância de domínio (service backend + operação no grafo > telas de UI que
  // só citam a entidade). Cap pra não pagar custo num monorepo onde "shared" aparece em dezenas de
  // lugares. Sem isso, o arquivo-mãe afunda sob ruído de frontend e o par certo nunca é montado.
  const focoLista = rankearFoco(indice, entidades)
    .slice(0, MAX_ARQUIVOS_FOCO)
    .map((c) => c.arquivo)
  const foco = new Set(focoLista)

  const chamadas = chamadasDeOperacao(indice, foco)
  const pares = parearPorGrafo(chamadas, entidades)

  const rotulo = entidades.find((e) => TERMOS_SHARED.includes(e)) ?? entidades[0] ?? "a entidade"
  const mapaSimbolos = simbolosDoMapa(indice, sementes, pares, foco)
  const trechos = await extrairTrechos(raiz, alvosDeTrecho(indice, sementes, pares, foco))

  const blocos = [
    renderMapa(mapaSimbolos),
    renderPares(pares, rotulo),
    renderTrechos(trechos),
    renderPrecedentes(precedentes),
  ].filter(Boolean)

  const texto = blocos.join("\n\n").slice(0, MAX_CHARS_PACOTE)
  // Forte = o índice resolveu material de verdade: pelo menos um par OU trechos cirúrgicos de >= 2
  // símbolos casados. Senão, o sintoma não casou o código pelo nome — degrada pro grep.
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
  }
}
