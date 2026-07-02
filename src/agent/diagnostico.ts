import { generateText } from "ai"
import { extrairEntidades, ehGenerico } from "../engine/marques"
import { comandoBusca, comandoContagem, rodar } from "../tools"
import { montarPacote, escoposCitados } from "./contexto"
import { localizarComSmell } from "./smells"
import { navegarDiagnostico } from "./navegador"
import { verificarCausa, extrairCausaAlvo } from "./verificador"
import { carregarIndice } from "../conhecimento"
import { criarResumirFn } from "../context/resumir"
import { listarFontes } from "../conhecimento/walk"

const MAX_HITS = 15
const TIMEOUT_BUSCA = 15_000
const MAX_TRECHO = 160

export type Hit = { arquivo: string; linha: number; trecho: string }
export type MapaComparacao = { entidades: string[]; hits: Hit[]; texto: string }

const MIN_ESPECIFICOS = 2

export function queryDe(entidades: string[]): string {
  const especificos = entidades.filter((e) => !ehGenerico(e))
  const usados = especificos.length >= MIN_ESPECIFICOS ? especificos : entidades
  return usados
    .map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter((e) => e.length > 0)
    .join("|")
}

export function parseHits(saida: string, max = MAX_HITS): Hit[] {
  const hits: Hit[] = []
  for (const linha of saida.split("\n")) {
    if (!linha.trim()) continue
    const m = linha.match(/^(.+?):(\d+):(.*)$/)
    if (!m) continue
    const trecho = m[3].trim()
    hits.push({
      arquivo: m[1].replace(/^\.\//, ""),
      linha: Number(m[2]),
      trecho: trecho.length > MAX_TRECHO ? `${trecho.slice(0, MAX_TRECHO)}…` : trecho,
    })
    if (hits.length >= max) break
  }
  return hits
}

export function renderMapa(entidades: string[], hits: Hit[]): string {
  if (!hits.length) return ""
  const cabecalho = `PONTOS QUE TOCAM EM ${entidades.join(", ")} (compare os que deveriam se comportar igual):`
  const corpo = hits.map((h) => `- ${h.arquivo}:${h.linha}  ${h.trecho}`).join("\n")
  return `${cabecalho}\n${corpo}`
}

export async function mapaDeComparacao(input: string): Promise<MapaComparacao> {
  const entidades = extrairEntidades(input)
  if (!entidades.length) return { entidades, hits: [], texto: "" }
  const query = queryDe(entidades)
  if (!query) return { entidades, hits: [], texto: "" }
  const { saida } = await rodar(comandoBusca(query), undefined, TIMEOUT_BUSCA)
  const hits = parseHits(saida)
  return { entidades, hits, texto: renderMapa(entidades, hits) }
}

const MAX_FICHEIROS = 8
const MAX_LINHAS_DOSSIE = 220
const MAX_RODADAS_RACIOCINIO = 3

export type ArquivoRank = { arquivo: string; hits: number }

export async function arquivosRelevantes(entidades: string[], prefixos: string[] = []): Promise<ArquivoRank[]> {
  const query = queryDe(entidades)
  if (!query) return []
  const { saida } = await rodar(comandoContagem(query), undefined, TIMEOUT_BUSCA)
  const noEscopo = (arquivo: string) =>
    prefixos.length === 0 || prefixos.some((p) => arquivo === p || arquivo.startsWith(`${p}/`))
  return saida
    .split("\n")
    .map((l) => l.match(/^(.+):(\d+)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ arquivo: m[1].replace(/^\.\//, ""), hits: Number(m[2]) }))
    .filter((a) => noEscopo(a.arquivo))
    .slice(0, MAX_FICHEIROS)
}

export async function lerDossie(entidades: string[], prefixos: string[] = []): Promise<string> {
  const arquivos = await arquivosRelevantes(entidades, prefixos)
  const partes: string[] = []
  for (const { arquivo } of arquivos) {
    try {
      const f = Bun.file(arquivo)
      if (!(await f.exists())) continue
      const linhas = (await f.text()).split("\n").slice(0, MAX_LINHAS_DOSSIE)
      const numeradas = linhas.map((l, i) => `${i + 1}\t${l}`).join("\n")
      partes.push(`### ${arquivo}\n${numeradas}`)
    } catch {}
  }
  return partes.join("\n\n")
}

const MAX_PARES = 4
const MIN_ARQUIVO_PRA_PAREAR = 2

const RE_DEF_METODO =
  /^\s*(?:(?:public|private|protected|internal|open|override|suspend|static|final|fun|def|func|function|fn|sub|async|export|const|val|let)\s+)*(?:fun|def|func|function|fn|sub)?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/

const FAMILIAS_OP: { familia: string; re: RegExp }[] = [
  { familia: "findFirst", re: /\bfindFirst\w*\s*\(/ },
  { familia: "findBy", re: /\bfindBy\w*\s*\(/ },
  { familia: "findAll", re: /\bfindAll\w*\s*\(/ },
  { familia: "save", re: /\.save\w*\s*\(/ },
  { familia: "delete", re: /\.delete\w*\s*\(/ },
  { familia: "update", re: /\.update\w*\s*\(/ },
  { familia: "query", re: /\bquery\w*\s*\(|@Query\b/ },
]

type Metodo = { nome: string; inicio: number; fim: number }
type ChamadaOp = { metodo: string; familia: string; linha: number; trecho: string; alvo: string }

function extrairMetodos(linhas: string[]): Metodo[] {
  const defs: { nome: string; inicio: number }[] = []
  for (let i = 0; i < linhas.length; i++) {
    const m = linhas[i].match(RE_DEF_METODO)
    if (m && m[1] && !PALAVRAS_NAO_METODO.has(m[1])) defs.push({ nome: m[1], inicio: i })
  }
  return defs.map((d, idx) => ({
    nome: d.nome,
    inicio: d.inicio,
    fim: idx + 1 < defs.length ? defs[idx + 1].inicio : linhas.length,
  }))
}

const PALAVRAS_NAO_METODO = new Set([
  "if", "for", "while", "when", "switch", "catch", "return", "with", "synchronized",
  "listOf", "setOf", "mapOf", "arrayOf", "require", "check", "println", "print",
])

const MAX_TRECHO_PAR = 110

const RE_ALVO_OP = /\b(find\w+|save\w*|delete\w*|update\w*|query\w*)\s*\(/

function chamadasDeOperacao(linhas: string[], metodos: Metodo[]): ChamadaOp[] {
  const chamadas: ChamadaOp[] = []
  for (const met of metodos) {
    for (let i = met.inicio; i < met.fim; i++) {
      for (const { familia, re } of FAMILIAS_OP) {
        if (!re.test(linhas[i])) continue
        const trecho = linhas[i].trim()
        chamadas.push({
          metodo: met.nome,
          familia,
          linha: i + 1,
          trecho: trecho.length > MAX_TRECHO_PAR ? `${trecho.slice(0, MAX_TRECHO_PAR)}…` : trecho,
          alvo: linhas[i].match(RE_ALVO_OP)?.[1] ?? familia,
        })
        break
      }
    }
  }
  return chamadas
}

type ChamadaCtx = ChamadaOp & { arquivo: string; arquivoCasaEntidade: boolean }

export type Par = {
  entidade: string
  familia: string
  a: ChamadaOp & { arquivo: string }
  b: ChamadaOp & { arquivo: string }
}

const MIN_TOKEN_ENTIDADE = 4

function metodoTocaEntidade(
  metodo: string,
  corpo: string,
  entidades: string[],
  arquivoCasaEntidade: boolean,
): boolean {
  if (arquivoCasaEntidade) return true
  const alvo = `${metodo}\n${corpo}`.toLowerCase()
  return entidades.some((e) => e.length >= MIN_TOKEN_ENTIDADE && alvo.includes(e.toLowerCase()))
}

function arquivoCasaEntidade(arquivo: string, entidades: string[]): boolean {
  const base = (arquivo.split("/").pop() ?? "").toLowerCase()
  return entidades.some((e) => e.length >= MIN_TOKEN_ENTIDADE && base.includes(e.toLowerCase()))
}

const MAX_BYTES_ARQUIVO = 200_000

export async function montarPares(entidades: string[], arquivos: ArquivoRank[]): Promise<Par[]> {
  const especificos = entidades.filter((e) => !ehGenerico(e))
  const alvos = (especificos.length ? especificos : entidades).map((e) => e.toLowerCase())
  const ranqueados = arquivos.filter((a) => a.hits >= MIN_ARQUIVO_PRA_PAREAR)
  const porFamilia = new Map<string, ChamadaCtx[]>()

  for (const { arquivo } of ranqueados) {
    let texto: string
    try {
      const f = Bun.file(arquivo)
      if (!(await f.exists()) || f.size > MAX_BYTES_ARQUIVO) continue
      texto = await f.text()
    } catch {
      continue
    }
    const linhas = texto.split("\n")
    const metodos = extrairMetodos(linhas)
    const arqCasa = arquivoCasaEntidade(arquivo, alvos)
    for (const met of metodos) {
      const corpo = linhas.slice(met.inicio, met.fim).join("\n")
      if (!metodoTocaEntidade(met.nome, corpo, alvos, arqCasa)) continue
      for (const ch of chamadasDeOperacao(linhas, [met])) {
        const lista = porFamilia.get(ch.familia) ?? []
        lista.push({ ...ch, arquivo, arquivoCasaEntidade: arqCasa })
        porFamilia.set(ch.familia, lista)
      }
    }
  }

  const candidatos: { par: Par; score: number }[] = []
  for (const [familia, chamadas] of porFamilia) {
    for (const [a, b] of combinar(chamadas)) {
      if (a.metodo === b.metodo || a.trecho === b.trecho) continue
      candidatos.push({ par: { entidade: alvos[0] ?? "", familia, a, b }, score: pontuarPar(a, b, alvos) })
    }
  }
  candidatos.sort((x, y) => y.score - x.score)

  const pares: Par[] = []
  const usados = new Set<string>()
  for (const { par } of candidatos) {
    if (pares.length >= MAX_PARES) break
    const chave = [`${par.a.arquivo}:${par.a.metodo}`, `${par.b.arquivo}:${par.b.metodo}`].sort().join("|")
    if (usados.has(chave)) continue
    usados.add(chave)
    pares.push(par)
  }
  return pares
}

const SUFIXO_MIN = 4

function pontuarPar(a: ChamadaCtx, b: ChamadaCtx, entidades: string[]): number {
  let s = 0
  if (sufixoComum(a.alvo, b.alvo).length >= SUFIXO_MIN) s += 4
  if (a.arquivo === b.arquivo) s += 2
  if (a.arquivoCasaEntidade || b.arquivoCasaEntidade) s += 1
  const cita = (txt: string) =>
    entidades.some((e) => e.length >= MIN_TOKEN_ENTIDADE && txt.toLowerCase().includes(e.toLowerCase()))
  if (cita(`${a.trecho} ${b.trecho}`)) s += 3
  if (cita(`${a.metodo} ${b.metodo}`)) s += 2
  return s
}

function sufixoComum(x: string, y: string): string {
  const a = x.toLowerCase()
  const b = y.toLowerCase()
  let i = 0
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return a.slice(a.length - i)
}

function* combinar<T>(xs: T[]): Generator<[T, T]> {
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) yield [xs[i], xs[j]]
  }
}

export function renderPares(pares: Par[], entidades: string[]): string {
  if (!pares.length) return ""
  const rotulo = entidades.filter((e) => !ehGenerico(e))[0] ?? entidades[0] ?? "a entidade"
  const blocos = pares.map((p, i) => {
    const n = i + 1
    return (
      `PAR ${n} — caminhos que operam sobre "${rotulo}" via ${p.familia} (compare-os):\n` +
      `  [A] ${p.a.metodo} (${p.a.arquivo}:${p.a.linha})\n` +
      `      ${p.a.trecho}\n` +
      `  [B] ${p.b.metodo} (${p.b.arquivo}:${p.b.linha})\n` +
      `      ${p.b.trecho}\n` +
      `  PERGUNTA: [A] e [B] lidam com "${rotulo}" e ambos usam ${p.familia}. Por que usam chamadas diferentes? Qual está correto e qual causa o sintoma?`
    )
  })
  return `COMPARAÇÃO PAREADA (já feita pra você — analise, NÃO busque mais):\n\n${blocos.join("\n\n")}`
}

const RE_FALTA = /^\s*FALTA:\s*(.+)$/im

const RE_ARQUIVO_LINHA = /[\w./-]+\.[A-Za-z]{1,5}:\d+|\blinha\s+\d+\b/i

export function detectouHedge(texto: string): boolean {
  if (RE_FALTA.test(texto)) return true
  return !RE_ARQUIVO_LINHA.test(texto)
}

const SISTEMA_RACIOCINIO =
  "Você é um diagnosticador de bugs sênior, em português brasileiro. Recebe um SINTOMA, uma COMPARAÇÃO PAREADA e os TRECHOS de código que tocam no sintoma. " +
  "Os pontos relevantes JÁ foram mapeados e lidos pra você abaixo. NÃO busque, NÃO liste arquivos, NÃO peça pra explorar: analise o material dado e produza o diagnóstico. " +
  "Tarefa: se há COMPARAÇÃO PAREADA, responda a pergunta de cada par — compare os caminhos [A] e [B] que deveriam se comportar igual e diga qual diverge e causa o sintoma. Baseie-se SÓ no código dado, não invente. " +
  "IMPORTANTE: só se o material for de fato INSUFICIENTE (o arquivo onde a operação acontece não está em NENHUM trecho abaixo), responda APENAS com a linha:\n" +
  "FALTA: caminho/arquivo1.kt, caminho/arquivo2.kt\n" +
  "listando os arquivos exatos que faltam. NÃO chute conclusão sobre material incompleto, mas também NÃO peça arquivo que já está abaixo.\n" +
  "Com material suficiente, responda CURTO e estruturado, sem hedge (nada de 'provavelmente'/'talvez'): (1) CAUSA RAIZ — arquivo:linha e o trecho exato; (2) CORREÇÃO — o que trocar por quê (de X para Y), preciso o bastante pra outro dev aplicar sem pensar."

const ESCOPADO_SUFIXO =
  "\n\nESTE É TODO O MATERIAL relevante ao sintoma (superfície escopada). NÃO responda 'FALTA:' nem peça mais arquivos — a causa ESTÁ neste código; aponte a CAUSA RAIZ (arquivo:linha) com o que está aqui."

export function parseFalta(texto: string): string[] {
  const m = texto.match(RE_FALTA)
  if (!m) return []
  return m[1]
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/^\.\//, ""))
    .filter((s) => /\.[a-z]{1,5}$/i.test(s))
    .slice(0, 4)
}

async function lerArquivos(caminhos: string[]): Promise<string> {
  const partes: string[] = []
  for (const arq of caminhos) {
    try {
      const f = Bun.file(arq)
      if (!(await f.exists())) continue
      const linhas = (await f.text()).split("\n").slice(0, MAX_LINHAS_DOSSIE)
      partes.push(`### ${arq}\n${linhas.map((l, i) => `${i + 1}\t${l}`).join("\n")}`)
    } catch {}
  }
  return partes.join("\n\n")
}

export type Material = {
  entidades: string[]
  hits: number
  pares: Par[]
  dossie: string
  texto: string
  fonte: "indice" | "grep"

  escopado: boolean
}
export type ResultadoDiagnostico = {
  texto: string
  inTok: number
  outTok: number
  rodadas: number
  resolvido: boolean
}
export type ResultadoFallback = ResultadoDiagnostico & {
  modelo: string
  modelosUsados: string[]
  custoUSD: number
  cravou: boolean
}

export async function reunirMaterial(input: string): Promise<Material> {
  const pacote = await montarPacote(process.cwd(), input, criarResumirFn())
  if (pacote.forte && pacote.texto.trim()) {
    const pares: Par[] = pacote.pares.map((p) => ({
      entidade: p.entidade,
      familia: p.familia,
      a: { metodo: p.a.metodo, familia: p.familia, linha: p.a.linha, trecho: `${p.a.chamada}()`, alvo: p.a.chamada, arquivo: p.a.arquivo },
      b: { metodo: p.b.metodo, familia: p.familia, linha: p.b.linha, trecho: `${p.b.chamada}()`, alvo: p.b.chamada, arquivo: p.b.arquivo },
    }))
    return { entidades: pacote.entidades, hits: pacote.simbolosCasados, pares, dossie: pacote.texto, texto: pacote.texto, fonte: "indice", escopado: pacote.escopado }
  }
  return reunirMaterialGrep(input)
}

async function reunirMaterialGrep(input: string): Promise<Material> {
  const entidades = extrairEntidades(input)
  const prefixos = await escoposCitados(process.cwd(), input, await listarFontes(process.cwd()))
  const ranking = await arquivosRelevantes(entidades, prefixos)
  const [dossie, pares] = await Promise.all([lerDossie(entidades, prefixos), montarPares(entidades, ranking)])
  const blocoPares = renderPares(pares, entidades)
  const texto = blocoPares ? `${blocoPares}\n\n--- código completo dos pontos ---\n${dossie}` : dossie
  return { entidades, hits: ranking.reduce((s, a) => s + a.hits, 0), pares, dossie, texto, fonte: "grep", escopado: false }
}

export async function diagnosticar(
  input: string,
  model: Parameters<typeof generateText>[0]["model"],
  onMapa: (n: number) => void,
  signal?: AbortSignal,
  materialPronto?: Material,
  effort: Esforco = "high",
): Promise<ResultadoDiagnostico> {
  const material = materialPronto ?? (await reunirMaterial(input))
  onMapa(material.hits)
  let dossie = material.texto
  const jaLido = new Set<string>()
  let inTok = 0
  let outTok = 0
  let texto = ""
  let rodadas = 0

  const maxRodadas = material.escopado ? 1 : MAX_RODADAS_RACIOCINIO
  for (let i = 1; i <= maxRodadas; i++) {
    rodadas = i
    const r = await raciocinarDiagnostico(input, dossie, model, signal, effort, material.escopado)
    inTok += r.inTok
    outTok += r.outTok
    texto = r.texto

    const pedidos = parseFalta(texto).filter((p) => !jaLido.has(p))
    if (!pedidos.length) break
    pedidos.forEach((p) => jaLido.add(p))
    const extra = await lerArquivos(pedidos)
    if (!extra) break
    dossie += `\n\n${extra}`
  }

  return { texto, inTok, outTok, rodadas, resolvido: !RE_FALTA.test(texto) }
}

const TOP_SHORTLIST = 3
const SISTEMA_TERMOS = `Você é um localizador de código. Dado um relato LEIGO de bug, liste de 6 a 10 termos de busca que aparecem LITERALMENTE no código-fonte.
REGRAS:
- Termos CURTOS: uma palavra só, minúsculas. Raízes reais (auth, password, login, token, session, retry, timeout, lock, mutex, dedup, refund, credit, webhook, ssrf, proxy, sanitize, xss, escape).
- NÃO invente nomes compostos tipo "UserAuthenticationEntry". Código usa raízes curtas.
- Inclua o jargão técnico da CLASSE do problema (segurança→ssrf/xss/sanitize; concorrência→lock/mutex/race; retry→retry/backoff).
- Um por linha. Sem prosa, sem numeração.`

async function traduzirParaTermos(
  input: string,
  model: Parameters<typeof generateText>[0]["model"],
  signal?: AbortSignal,
): Promise<{ termos: string[]; inTok: number; outTok: number }> {
  const r = await generateText({ model, system: SISTEMA_TERMOS, prompt: input, temperature: 0, abortSignal: signal })
  const termos = r.text
    .split("\n")
    .map((l) => l.replace(/^[-*\d.\s]+/, "").trim().toLowerCase())
    .filter((l) => /^[a-z][a-z0-9_]{2,}$/.test(l))
    .slice(0, 10)
  return { termos, inTok: r.usage?.inputTokens ?? 0, outTok: r.usage?.outputTokens ?? 0 }
}

async function diagnosticarNavegando(
  input: string,
  cadeia: string[],
  criarModel: (slug: string) => Parameters<typeof generateText>[0]["model"],
  custoDe: (slug: string, inTok: number, outTok: number) => number,
  signal?: AbortSignal,
): Promise<ResultadoFallback | null> {
  try {
    const slug = cadeia[0]
    const model = criarModel(slug)
    const indice = await carregarIndice(process.cwd())
    if (!indice) return null
    const t = await traduzirParaTermos(input, model, signal)

    const candidatos = (await localizarComSmell(process.cwd(), indice, input, t.termos))
      .slice(0, TOP_SHORTLIST)
      .map((c) => c.arquivo)
    const nav = await navegarDiagnostico(input, process.cwd(), indice, candidatos, model, signal)
    let texto = nav.texto
    let cravou = nav.cravou
    let inTok = t.inTok + nav.inTok
    let outTok = t.outTok + nav.outTok
    let custo = custoDe(slug, inTok, outTok)
    const modelosUsados = [slug]

    const alvo = cravou ? extrairCausaAlvo(texto) : null
    if (alvo && process.env.COM_VERIFICADOR === "1") {

      const slugVerif = process.env.VERIF_FORTE === "1" ? (cadeia[2] ?? cadeia[cadeia.length - 1]) : cadeia[0]
      const v = await verificarCausa(input, process.cwd(), alvo.arquivo, alvo.linha, criarModel(slugVerif), signal)
      inTok += v.inTok
      outTok += v.outTok
      custo += custoDe(slugVerif, v.inTok, v.outTok)
      modelosUsados.push(slugVerif)
      if (!v.confirma) {
        const provaveis = candidatos.slice(0, 3).join(", ") || "—"
        texto = `NÃO CRAVEI: o verificador não confirmou que ${alvo.arquivo}:${alvo.linha} causa o sintoma (${v.motivo.split("\n")[0]}). Prováveis: ${provaveis}.`
        cravou = false
      }
    }

    return {
      texto,
      inTok,
      outTok,
      rodadas: nav.passos,
      resolvido: cravou,
      custoUSD: custo,
      modelo: slug,
      modelosUsados,
      cravou,
    }
  } catch {
    return null
  }
}

export async function diagnosticarComFallback(
  input: string,
  cadeia: string[],
  criarModel: (slug: string) => Parameters<typeof generateText>[0]["model"],
  custoDe: (slug: string, inTok: number, outTok: number) => number,
  onMapa: (n: number) => void,
  onTroca: (slug: string) => void,
  signal?: AbortSignal,
): Promise<ResultadoFallback> {
  const material = await reunirMaterial(input)

  if (cadeia.length) {
    const nav = await diagnosticarNavegando(input, cadeia, criarModel, custoDe, signal)
    if (nav?.cravou) {
      onMapa(material.hits)
      return nav
    }
  }
  let inTok = 0
  let outTok = 0
  let rodadas = 0
  let custo = 0
  const modelosUsados: string[] = []
  let ultimo: ResultadoDiagnostico = { texto: "", inTok: 0, outTok: 0, rodadas: 0, resolvido: false }
  let modelo = cadeia[0] ?? ""
  let primeiroMapa = true

  const maxModelos = material.pares.length > 0 ? cadeia.length : 1
  for (let i = 0; i < cadeia.length && i < maxModelos; i++) {
    const slug = cadeia[i]
    modelo = slug
    modelosUsados.push(slug)
    onTroca(slug)

    const effort: Esforco = i === 0 ? "medium" : "high"
    const r = await diagnosticar(
      input,
      criarModel(slug),
      (n) => {
        if (primeiroMapa) {
          onMapa(n)
          primeiroMapa = false
        }
      },
      signal,
      material,
      effort,
    )
    inTok += r.inTok
    outTok += r.outTok
    rodadas += r.rodadas
    custo += custoDe(slug, r.inTok, r.outTok)
    ultimo = r
    if (signal?.aborted) break
    if (!detectouHedge(r.texto)) break
  }

  return {
    texto: ultimo.texto,
    inTok,
    outTok,
    rodadas,
    custoUSD: custo,
    resolvido: ultimo.resolvido,
    modelo,
    modelosUsados,
    cravou: ultimo.resolvido && !detectouHedge(ultimo.texto),
  }
}

export type CandidatoDiagnostico = { texto: string; inTok: number; outTok: number }

const TEMPS_CANDIDATOS = [0.2, 0.5, 0.8, 1.0]

export async function gerarCandidatosDiagnostico(
  input: string,
  material: Material,
  model: Parameters<typeof generateText>[0]["model"],
  n: number,
  signal?: AbortSignal,
): Promise<CandidatoDiagnostico[]> {
  const tarefas = Array.from({ length: n }, (_, i) =>
    raciocinarDiagnostico(input, material.texto, model, signal, "high", material.escopado, TEMPS_CANDIDATOS[i % TEMPS_CANDIDATOS.length])
      .then((r) => ({ candidato: { texto: r.texto, inTok: r.inTok, outTok: r.outTok }, cravou: r.texto.length > 0 && !detectouHedge(r.texto) }))
      .catch(() => null),
  )
  const res = await Promise.all(tarefas)
  return res.filter((r): r is { candidato: CandidatoDiagnostico; cravou: boolean } => r != null && r.cravou).map((r) => r.candidato)
}

export type Esforco = "low" | "medium" | "high"

export async function raciocinarDiagnostico(
  input: string,
  dossie: string,
  model: Parameters<typeof generateText>[0]["model"],
  signal?: AbortSignal,
  effort: Esforco = "high",
  escopado = false,
  temperatura = 0.2,
): Promise<{ texto: string; inTok: number; outTok: number }> {
  const r = await generateText({
    model,
    system: escopado ? SISTEMA_RACIOCINIO + ESCOPADO_SUFIXO : SISTEMA_RACIOCINIO,
    prompt: `SINTOMA:\n${input}\n\nTRECHOS DOS PONTOS QUE TOCAM NO SINTOMA:\n${dossie}\n\nCompare os caminhos e diagnostique.`,
    providerOptions: { openrouter: { reasoning: { effort } } },
    temperature: temperatura,
    abortSignal: signal,
  })
  const u = r.usage as {
    inputTokens?: number
    outputTokens?: number
    promptTokens?: number
    completionTokens?: number
  }
  return {
    texto: r.text.trim(),
    inTok: u?.inputTokens ?? u?.promptTokens ?? 0,
    outTok: u?.outputTokens ?? u?.completionTokens ?? 0,
  }
}
