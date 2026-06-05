import { readdir } from "node:fs/promises"
import { indexar, type Indice, buscarPrecedente, type Precedente } from "../conhecimento"
import type { Simbolo, ArquivoSimbolos } from "../conhecimento"
import { gerarResumos, type CacheResumos, type ResumirFn, type AlvoResumo } from "../conhecimento/resumos"
import { listarFontes, type ArquivoFonte } from "../conhecimento/walk"
import { extrairEntidades, ehGenerico, perfilTermos, expandirDominio } from "../engine/marques"

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
  // Cirúrgico afunda ruído (UI/gen/teste) pra achar o ponto do bug. Amplo (compreender) NÃO penaliza:
  // cobertura > precisão — o panorama quer ver as telas e o gerado também, não só o service.
  if (c.ruido && modo === "cirurgico") s += PESO_RUIDO
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

/**
 * Mapa de 1 linha por símbolo relevante (assinatura). Orienta o modelo sem despejar arquivo inteiro.
 * 1.4 — na PRIMEIRA aparição de cada arquivo, anexa o resumo de 1 linha (gerado pelo modelo barato,
 * cacheado) quando há um — dá "o que este arquivo faz" sem o código. Sem resumo, cai só na assinatura.
 */
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

/** Monta os alvos de resumo (1.4) dos arquivos-foco: lê conteúdo + hash pra gerarResumos cachear. */
async function alvosResumo(raiz: string, arquivos: string[]): Promise<AlvoResumo[]> {
  const out: AlvoResumo[] = []
  for (const arquivo of arquivos) {
    try {
      const conteudo = await Bun.file(`${raiz}/${arquivo}`).text()
      out.push({ arquivo, hash: Bun.hash(conteudo).toString(16), conteudo })
    } catch {
      // arquivo ilegível: ignora — o mapa cai na assinatura pra ele
    }
  }
  return out
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
  // Material veio da SUPERFÍCIE ESCOPADA (SDK pequeno inteiro), não de um par preciso. O gate de
  // escalada usa isso: superfície é contexto BOM (pode escalar 1x), mas não é o par (sweet spot).
  escopado: boolean
}

const MAX_ARQ_SUPERFICIE = 32
const MAX_LINHAS_SUPERFICIE = 90
const MAX_CHARS_SUPERFICIE = 24_000
const MIN_TOKEN_ESCOPO = 3
const MIN_ANALOGOS_CROSS = 3

/** Quantos basenames os dois subtrees compartilham — mede se são PARES (SDKs irmãos) vs coisas díspares. */
function analogosCompartilhados(fontes: ArquivoFonte[], a: string, b: string): number {
  const bn = (st: string) =>
    new Set(fontes.filter((f) => f.caminho.startsWith(`${st}/`)).map((f) => basenameSemExt(f.caminho)))
  const bnA = bn(a)
  const bnB = bn(b)
  let n = 0
  for (const x of bnA) if (bnB.has(x)) n++
  return n
}

// Arquivos que mais provavelmente contêm o bug (config/cliente/http/base/entrypoint) vêm primeiro;
// testes por último. Resolve os bugs "scan-de-literal" (base_url, import morto) sem depender de linguagem.
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

/**
 * Escopos citados — AGNÓSTICO de linguagem. Casa os tokens do sintoma contra a ÁRVORE REAL do
 * projeto (nomes de pasta), não contra uma lista de linguagens. "python" escopa porque existe
 * `arara-python-sdk` e o token bate; `auth`/`billing`/`zig-sdk` num projeto qualquer funcionam igual,
 * sem nada chumbado. Devolve até 2 subtrees (caminho relativo) — 2 = cross-compare ("X quebra, Y ok").
 * Ordenado pela posição no texto (o sujeito da queixa primeiro). Vazio se nenhum token casar a árvore.
 */
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
      // só "o segmento da pasta contém o token" — NÃO o contrário, senão "cliente" casa "cli".
      if (segs.some((s) => s.includes(tok))) {
        score++
        pos = Math.min(pos, baixo.indexOf(tok))
      }
    }
    if (score > 0) cands.push({ st, score, pos })
  }
  if (!cands.length) return []
  // mais tokens casados primeiro; empate -> caminho MAIS CURTO (o repo vence o subdir, pra cross-compare
  // ser repo-vs-repo e o manifesto da raiz entrar); depois posição no texto.
  cands.sort((a, b) => b.score - a.score || a.st.length - b.st.length || a.pos - b.pos)

  const escolhidos: { st: string; pos: number }[] = []
  for (const c of cands) {
    if (escolhidos.some((e) => c.st.startsWith(`${e.st}/`) || e.st.startsWith(`${c.st}/`))) continue
    escolhidos.push({ st: c.st, pos: c.pos })
    if (escolhidos.length >= 2) break
  }
  const ordenados = escolhidos.sort((a, b) => a.pos - b.pos).map((e) => e.st)
  // cross-compare só entre PARES (SDKs irmãos, com arquivos análogos suficientes). Senão — ex.: SDK
  // pequeno casado junto com o backend gigante por causa de um token genérico ("api") — escopa só no
  // primeiro citado (o sujeito da queixa), pra não comparar coisas díspares nem estourar o orçamento.
  if (ordenados.length === 2 && analogosCompartilhados(fontes, ordenados[0], ordenados[1]) < MIN_ANALOGOS_CROSS) {
    return [ordenados[0]]
  }
  return ordenados
}

/** Arquivos de texto pequenos na RAIZ de um subtree (manifestos: pyproject/package.json/go.mod/etc),
 * agnóstico — pega o que estiver lá, sem lista chumbada. É o ponto C: deixa o modelo ver a versão/contrato. */
async function manifestosDaRaiz(raiz: string, st: string): Promise<string[]> {
  try {
    const entradas = await readdir(`${raiz}/${st}`, { withFileTypes: true })
    return entradas.filter((e) => e.isFile()).map((e) => `${st}/${e.name}`)
  } catch {
    return []
  }
}

/**
 * Superfície escopada: o sintoma aponta um (ou dois) subtree e o índice não casou um ponto preciso.
 * Em vez de lixo, entrega o subtree PEQUENO INTEIRO pro modelo escanear — "ver todos os arquivos da
 * pasta". Inclui os MANIFESTOS da raiz (C: versão/contrato à vista). Com DOIS subtrees vira
 * COMPARAÇÃO (A): prioriza os arquivos análogos (mesmo basename nos dois) e marca pra o modelo achar
 * o que DIVERGE — é o par cross-repo, o ponto forte da arquitetura aplicado a SDKs. Agnóstico.
 */
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
  // arquivo cujo NOME casa um token do sintoma ("template" -> Templates.php) é o suspeito nº1.
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
  // Manifesto entra com peso médio (vê versão/contrato) mas NÃO atropela o arquivo do bug (token/config).
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
        // arquivo ilegível: ignora
      }
    }
  }
  if (!arquivos.length) return null
  const cab = cross
    ? "COMPARE os dois ecossistemas abaixo — um funciona, o outro tem o bug. O ponto onde DIVERGEM é a causa. Aponte arquivo:linha:"
    : "CÓDIGO ESCOPADO (o ponto do sintoma ESTÁ aqui dentro — escaneie e aponte arquivo:linha):"
  return { texto: `${cab}\n\n${blocos.join("\n\n")}`, arquivos }
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

// --- Retrieval por TERMOS (Marques) — a ponte sintoma-leigo -> arquivo, determinística e grátis ----

const MAX_FOCO_TERMOS = 6

/** Superfície de busca de um arquivo (sem reler do disco): caminho + nomes de símbolo + assinaturas. */
function textoIndexadoDoArquivo(a: ArquivoSimbolos): string {
  const simbolos = a.simbolos.map((s) => `${s.nome} ${s.assinatura}`).join(" ")
  return `${a.arquivo.replace(/[/.]/g, " ")} ${simbolos}`
}

/**
 * Ranqueia os arquivos do índice por relevância ao sintoma usando o Marques: casa os termos do
 * pedido (expandidos via ponte de domínio PT→EN, aterrada no vocabulário REAL do projeto) contra o
 * perfil de frequência de cada arquivo. É o caminho que acha o arquivo quando o nome do símbolo NÃO
 * casa a palavra do leigo ("recarga/saldo" -> addCredit). Zero token. Penaliza ruído (UI/test/gen).
 */
function rankearPorTermos(indice: Indice, input: string): { arquivo: string; score: number }[] {
  const vocab = new Set<string>()
  const perfis = indice.simbolos.map((a) => {
    // Perfil do CONTEÚDO (indexado na Camada 1) — pega constante/config/valor que o nome de símbolo
    // não tem. Cai pro perfil de símbolos só se o índice for antigo (sem termos de conteúdo).
    const conteudo = indice.termos[a.arquivo]
    const perfil = conteudo?.length ? new Map(conteudo) : perfilTermos(textoIndexadoDoArquivo(a))
    for (const k of perfil.keys()) vocab.add(k)
    return { arquivo: a.arquivo, perfil }
  })
  // Recall: usa os termos COMPLETOS do sintoma (perfilTermos), não a lista podada de entidades — que
  // joga "crédito" fora como genérico e deixa o desabafo do leigo crowdar os termos úteis. Soma os
  // sinônimos PT->EN das entidades, expande pela ponte de domínio e aterra no vocab real do projeto.
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

/** Despeja o conteúdo dos arquivos escolhidos pelo retrieval (cap de linhas/chars). O modelo lê e
 * aponta arquivo:linha. Usado quando o índice não montou par nem subtree, mas os termos acharam alvo. */
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
      // arquivo ilegível: ignora
    }
  }
  if (!usados.length) return null
  return {
    texto: `CÓDIGO RELEVANTE (selecionado por frequência de termos — o ponto do sintoma ESTÁ aqui, aponte arquivo:linha):\n\n${blocos.join("\n\n")}`,
    arquivos: usados,
  }
}

/**
 * Monta o pacote de contexto do diagnóstico via índice da Camada 1. Garante o índice fresco
 * (incremental, barato), resolve sementes pelo reverso, pareia por grafo, extrai os corpos cirúrgicos
 * e injeta precedentes da memória. `forte` indica se o índice resolveu o bastante; quando fraco, quem
 * chama degrada pro gather antigo por grep. Reusável: o mesmo pacote alimenta todos os modelos da
 * cadeia de fallback sem recomputar I/O. O ÚNICO toque de modelo é 1.4 (resumo BARATO de 1 linha por
 * arquivo-foco, cacheado por hash — 1x por arquivo) quando `resumir` é passado; sem ele, lê só o cache.
 */
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

  // Escopo AGNÓSTICO por árvore real: casa os tokens do sintoma contra as pastas que existem ("python"
  // -> arara-python-sdk; "auth" -> pasta auth; sem lista de linguagens). Restringe a busca ao(s)
  // subtree(s) citado(s) — dois = comparação cross-repo ("X quebra, Y funciona").
  const fontes = await listarFontes(raiz)
  const subtrees = await escoposCitados(raiz, input, fontes)
  const noEscopo = (arquivo: string) =>
    subtrees.length === 0 || subtrees.some((st) => arquivo === st || arquivo.startsWith(`${st}/`))

  const sementes = resolverSementes(indice, entidades).filter((s) => noEscopo(s.arquivo))
  // Foco rankeado por relevância de domínio (service backend + operação no grafo > telas de UI que
  // só citam a entidade). Cap pra não pagar custo num monorepo onde "shared" aparece em dezenas de
  // lugares. Sem isso, o arquivo-mãe afunda sob ruído de frontend e o par certo nunca é montado.
  const focoLista = rankearFoco(indice, entidades)
    .filter((c) => noEscopo(c.arquivo))
    .slice(0, MAX_ARQUIVOS_FOCO)
    .map((c) => c.arquivo)
  const foco = new Set(focoLista)

  const chamadas = chamadasDeOperacao(indice, foco)
  const pares = parearPorGrafo(chamadas, entidades)

  // Sem par preciso, mas o sintoma aponta um subtree? Entrega o subtree pequeno INTEIRO (superfície
  // escopada) pro modelo escanear — resolve bug de literal/config sem símbolo (base_url, import morto),
  // e com DOIS subtrees vira comparação cross-repo. Contexto bom (forte), mas não é o par (escopado).
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

  // Retrieval por TERMOS (Marques): nenhum par e o casamento estrito de NOME não achou foco. Casa o
  // sintoma (expandido pela ponte de domínio, aterrada no vocab) contra o perfil de cada arquivo —
  // acha o alvo quando a palavra do leigo não bate o nome do símbolo ("recarga/saldo" -> addCredit).
  // Zero token. Entrega a superfície dos top-N pro modelo escanear e apontar arquivo:linha.
  if (pares.length === 0 && focoLista.length === 0) {
    const ranqueados = rankearPorTermos(indice, input)
      .filter((r) => noEscopo(r.arquivo))
      .slice(0, MAX_FOCO_TERMOS)
    if (ranqueados.length) {
      const sup = await superficieDeArquivos(raiz, ranqueados.map((r) => r.arquivo))
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
  }

  const rotulo = entidades.find((e) => TERMOS_SHARED.includes(e)) ?? entidades[0] ?? "a entidade"
  const mapaSimbolos = simbolosDoMapa(indice, sementes, pares, foco)
  // 1.4 — resumos de 1 linha dos arquivos-foco (cacheados por hash; só gera no cache miss e se há fn).
  const resumos = await gerarResumos(raiz, await alvosResumo(raiz, focoLista), resumir)
  const trechos = await extrairTrechos(raiz, alvosDeTrecho(indice, sementes, pares, foco))

  const blocos = [
    renderMapa(mapaSimbolos, resumos),
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

/** Arquivos com mais símbolos (os "centrais") — panorama quando nenhuma entidade do pedido casa. */
function arquivosCentrais(indice: Indice): string[] {
  return [...indice.simbolos]
    .filter((a) => a.simbolos.length > 0)
    .sort((x, y) => y.simbolos.length - x.simbolos.length)
    .map((a) => a.arquivo)
}

/**
 * Camada 2 em modo AMPLO (copiloto — COMPREENDER): em vez do trecho cirúrgico do bug, monta um
 * PANORAMA — muitos arquivos relevantes com suas assinaturas + o resumo de 1 linha (1.4, cacheado).
 * Cobertura sobre precisão, SEM corpos (compreender é volume de leitura, não insight). Alimenta o
 * modelo barato de contexto longo. Sem entidade casando ("visão geral do projeto"), cai pros arquivos
 * com mais símbolos. Determinístico; o único toque de modelo é o resumo barato (via `resumir`), cacheado.
 */
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
