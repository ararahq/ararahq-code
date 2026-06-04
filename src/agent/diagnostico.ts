import { generateText } from "ai"
import { extrairEntidades, ehGenerico, linguagensCitadas } from "../engine/marques"
import { comandoBusca, comandoContagem, rodar } from "../tools"
import { montarPacote } from "./contexto"

const MAX_HITS = 15
const TIMEOUT_BUSCA = 15_000
const MAX_TRECHO = 160

export type Hit = { arquivo: string; linha: number; trecho: string }
export type MapaComparacao = { entidades: string[]; hits: Hit[]; texto: string }

const MIN_ESPECIFICOS = 2

/**
 * Monta a query de alternância pra busca. Se há termos específicos suficientes, descarta os
 * genéricos (number, message) — eles casam prosa/config e diluem os hits que importam.
 */
export function queryDe(entidades: string[]): string {
  const especificos = entidades.filter((e) => !ehGenerico(e))
  const usados = especificos.length >= MIN_ESPECIFICOS ? especificos : entidades
  return usados
    .map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter((e) => e.length > 0)
    .join("|")
}

/** Converte "caminho:linha:conteudo" (saída do rg/grep) em Hit estruturado. */
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

/** Renderiza o mapa de comparação em texto pra injetar no system prompt. */
export function renderMapa(entidades: string[], hits: Hit[]): string {
  if (!hits.length) return ""
  const cabecalho = `PONTOS QUE TOCAM EM ${entidades.join(", ")} (compare os que deveriam se comportar igual):`
  const corpo = hits.map((h) => `- ${h.arquivo}:${h.linha}  ${h.trecho}`).join("\n")
  return `${cabecalho}\n${corpo}`
}

/**
 * O truque central do diagnóstico (D3): transforma "ache o erro" (aberto, ruim pro modelo barato)
 * em "compare estes pontos" (fechado, bom). Extrai entidades, busca os pontos que as tocam,
 * e monta um mapa de comparação injetado no system. Degrada pra vazio se nada bater.
 */
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

/**
 * Ranqueia os arquivos por contagem de hits (mais matches = mais central ao sintoma). Quando o
 * sintoma cita uma linguagem, FILTRA pros arquivos daquele ecossistema — sem isso, num monorepo
 * poliglota a prosa casa centenas de arquivos e o dossiê explode (a passada do modelo dá timeout).
 */
export async function arquivosRelevantes(entidades: string[], exts: string[] = []): Promise<ArquivoRank[]> {
  const query = queryDe(entidades)
  if (!query) return []
  const { saida } = await rodar(comandoContagem(query), undefined, TIMEOUT_BUSCA)
  const noEscopo = (arquivo: string) => exts.length === 0 || exts.some((e) => arquivo.endsWith(e))
  return saida
    .split("\n")
    .map((l) => l.match(/^(.+):(\d+)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ arquivo: m[1].replace(/^\.\//, ""), hits: Number(m[2]) }))
    .filter((a) => noEscopo(a.arquivo))
    .slice(0, MAX_FICHEIROS)
}

/**
 * Lê o código real dos arquivos MAIS relevantes ao sintoma (ranqueados por contagem de hits,
 * com ruído excluído). Determinístico e rápido — dá ao raciocínio o material certo pra comparar,
 * em vez de uma busca aberta. Antes pegava os 4 primeiros por ordem do grep e vinha só frontend.
 */
export async function lerDossie(entidades: string[], exts: string[] = []): Promise<string> {
  const arquivos = await arquivosRelevantes(entidades, exts)
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

// --- Comparação pareada (D4) -------------------------------------------------
// O pulo do gato do diagnóstico: em vez de jogar arquivos crus e pedir "ache o bug" (pergunta
// aberta, ruim até pro modelo caro), o scaffold monta PARES de caminhos que operam sobre a MESMA
// entidade e chamam a MESMA família de operação (ex: dois métodos que fazem repo.findFirst*),
// lado a lado, com a pergunta fechada: "por que A e B divergem? qual causa o sintoma?".
// Isso converte descoberta em comparação — o que faz o modelo cravar.

const MAX_PARES = 4
const MIN_ARQUIVO_PRA_PAREAR = 2

// Definição de método/função em Kotlin/Java/TS/JS/Python/Go/Rust/PHP/Ruby. Captura o nome.
const RE_DEF_METODO =
  /^\s*(?:(?:public|private|protected|internal|open|override|suspend|static|final|fun|def|func|function|fn|sub|async|export|const|val|let)\s+)*(?:fun|def|func|function|fn|sub)?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/

// Famílias de operação sobre repositório/estado. Duas chamadas da MESMA família em métodos
// diferentes são candidatas a par (deveriam buscar/salvar igual, mas talvez divirjam).
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

/** Recorta as definições de método de um arquivo, com a faixa de linhas [início, fim) de cada um. */
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

// Tokens que o regex de definição pode capturar mas não são métodos (control flow, ctor de coleção).
const PALAVRAS_NAO_METODO = new Set([
  "if", "for", "while", "when", "switch", "catch", "return", "with", "synchronized",
  "listOf", "setOf", "mapOf", "arrayOf", "require", "check", "println", "print",
])

const MAX_TRECHO_PAR = 110

// Extrai o identificador chamado da família (ex: findFirstByOrganizationIdIsNullAndIsActiveTrue).
// O sufixo desse identificador define a "intenção" da query — chamadas com mesmo sufixo fazem a
// mesma coisa por caminhos diferentes (o que vira o par A vs B). Família como prefixo opcional.
const RE_ALVO_OP = /\b(find\w+|save\w*|delete\w*|update\w*|query\w*)\s*\(/

/** Acha TODAS as chamadas de cada família de operação dentro de cada método (não só a primeira). */
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

/**
 * Um método toca a entidade se: o nome dele a cita, OU o corpo dele a cita (camelCase ou prosa),
 * OU o arquivo é claramente da entidade (nome do arquivo casa). Olhar o CORPO é o que pega
 * resolveSender/assignSharedNumber no teste-mãe: o nome não diz "shared", mas a query no corpo sim.
 */
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

/** O nome do arquivo casa a entidade? (AraraPhoneNumberService casa "number"/"phone"). */
function arquivoCasaEntidade(arquivo: string, entidades: string[]): boolean {
  const base = (arquivo.split("/").pop() ?? "").toLowerCase()
  return entidades.some((e) => e.length >= MIN_TOKEN_ENTIDADE && base.includes(e.toLowerCase()))
}

const MAX_BYTES_ARQUIVO = 200_000

/**
 * Monta os pares de comparação a partir dos arquivos do dossiê (D4). Procura métodos que tocam a
 * entidade e chamam a MESMA família de operação, mas em pontos diferentes — e os apresenta lado a
 * lado. Prioriza pares INTRA-arquivo (mais provável de ser o caminho A vs B do mesmo serviço).
 * Determinístico, sem LLM. Degrada pra [] se não houver par óbvio (aí o dossiê cru basta).
 */
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
  // Não repete o mesmo método dos dois lados em pares diferentes: variedade de comparações.
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

/**
 * Score do par (D4): quão forte é como "caminho A vs B do mesmo bug". Pesos calibrados pra que o
 * par cujo CÓDIGO fala do sintoma vença um par só estruturalmente parecido. Pesos:
 * - mesma INTENÇÃO de query (alvos compartilham sufixo significativo, ex: ...IsActiveTrue): +4
 * - intra-arquivo (mesmo serviço): +2
 * - algum dos trechos cita um termo do sintoma (shared/dedicated...): +3
 * - algum dos nomes de método cita a entidade (assignSharedNumber): +2
 * - arquivo casa a entidade pelo nome: +1
 */
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

/** Maior sufixo comum entre dois identificadores (case-insensitive). Mede "mesma intenção de query". */
function sufixoComum(x: string, y: string): string {
  const a = x.toLowerCase()
  const b = y.toLowerCase()
  let i = 0
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return a.slice(a.length - i)
}

/** Gera todos os pares (i<j) de uma lista. */
function* combinar<T>(xs: T[]): Generator<[T, T]> {
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) yield [xs[i], xs[j]]
  }
}

/** Renderiza os pares como bloco de texto fechado pra injetar ANTES do dossiê cru no material da M3. */
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

// --- Detecção de "não cravou" (D6) -------------------------------------------
const RE_FALTA = /^\s*FALTA:\s*(.+)$/im
// Uma referência arquivo:linha concreta é o sinal de que cravou (apontou o ponto exato).
const RE_ARQUIVO_LINHA = /[\w./-]+\.[A-Za-z]{1,5}:\d+|\blinha\s+\d+\b/i

/**
 * O diagnóstico NÃO cravou? Função pura testável (D6). Apontar um arquivo:linha concreto é o sinal
 * DOMINANTE de que cravou — ressalvas de IMPLEMENTAÇÃO na seção CORREÇÃO ("deve ser corrigida", "se
 * o método não existir, adicione") são caveats do fix, não incerteza no diagnóstico, e NÃO devem
 * disparar o fallback (esse falso-positivo descartava diagnósticos corretos e queimava a cadeia toda).
 * Só não cravou se: ainda pede arquivo (FALTA:), ou não aponta nenhum ponto concreto (arquivo:linha).
 */
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

/** Extrai os arquivos que o raciocínio pediu pra ver (linha "FALTA: a, b"). [] se não pediu nada. */
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

/**
 * Reúne o material do diagnóstico SEM chamar LLM (D4). Caminho principal (Camada 2): monta o pacote
 * DETERMINÍSTICO via índice/grafo — sementes pelo índice reverso, comparação pareada a partir do
 * campo `chama` dos símbolos (não regex/grep), trechos cirúrgicos pelos ranges, precedentes da
 * memória. Se o índice vier FRACO (o sintoma não casou o código pelo nome), DEGRADE pro gather
 * antigo por grep — sem quebrar o caminho que já roda. Reusável: o mesmo material alimenta todos os
 * modelos da cadeia de fallback sem recomputar I/O.
 */
export async function reunirMaterial(input: string): Promise<Material> {
  const pacote = await montarPacote(process.cwd(), input)
  if (pacote.forte && pacote.texto.trim()) {
    const pares: Par[] = pacote.pares.map((p) => ({
      entidade: p.entidade,
      familia: p.familia,
      a: { metodo: p.a.metodo, familia: p.familia, linha: p.a.linha, trecho: `${p.a.chamada}()`, alvo: p.a.chamada, arquivo: p.a.arquivo },
      b: { metodo: p.b.metodo, familia: p.familia, linha: p.b.linha, trecho: `${p.b.chamada}()`, alvo: p.b.chamada, arquivo: p.b.arquivo },
    }))
    return { entidades: pacote.entidades, hits: pacote.simbolosCasados, pares, dossie: pacote.texto, texto: pacote.texto, fonte: "indice" }
  }
  return reunirMaterialGrep(input)
}

/** Gather LEGADO por grep (fallback quando o índice resolve pouco). Preserva o caminho v0.1.6. */
async function reunirMaterialGrep(input: string): Promise<Material> {
  const entidades = extrairEntidades(input)
  const exts = linguagensCitadas(input)[0]?.exts ?? []
  const ranking = await arquivosRelevantes(entidades, exts)
  const [dossie, pares] = await Promise.all([lerDossie(entidades, exts), montarPares(entidades, ranking)])
  const blocoPares = renderPares(pares, entidades)
  const texto = blocoPares ? `${blocoPares}\n\n--- código completo dos pontos ---\n${dossie}` : dossie
  return { entidades, hits: ranking.reduce((s, a) => s + a.hits, 0), pares, dossie, texto, fonte: "grep" }
}

/**
 * Diagnóstico com UM modelo: raciocina sobre o material já reunido, com FEEDBACK de FALTA.
 * Se o modelo disser que falta um arquivo (que o scaffold ainda não reuniu), lê e pensa de novo
 * (até MAX_RODADAS). Restaura o "perceber que falta material" sem a lentidão de pensar a cada passo.
 */
export async function diagnosticar(
  input: string,
  model: Parameters<typeof generateText>[0]["model"],
  onMapa: (n: number) => void,
  signal?: AbortSignal,
  materialPronto?: Material,
): Promise<ResultadoDiagnostico> {
  const material = materialPronto ?? (await reunirMaterial(input))
  onMapa(material.hits)
  let dossie = material.texto
  const jaLido = new Set<string>()
  let inTok = 0
  let outTok = 0
  let texto = ""
  let rodadas = 0

  for (let i = 1; i <= MAX_RODADAS_RACIOCINIO; i++) {
    rodadas = i
    const r = await raciocinarDiagnostico(input, dossie, model, signal)
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
  // resolvido = produziu um diagnóstico de verdade, não ficou pedindo arquivo que o scaffold não reuniu.
  return { texto, inTok, outTok, rodadas, resolvido: !RE_FALTA.test(texto) }
}

/**
 * Diagnóstico com fallback INVISÍVEL (M3, D6): reúne o material UMA vez e percorre a cadeia
 * Gemini -> GPT-5.5 -> Opus. Se um modelo não crava (detectouHedge: sem arquivo:linha, hedge, ou
 * ainda pedindo arquivo), repassa o MESMO material pro próximo, uma passada cada. Para no primeiro
 * que crava. Custo somado por modelo via `custoDe`; quem orquestra exibe só "Jade · diagnóstico".
 * `criarModel` instancia o provider por slug; `onTroca` avisa a troca (só pra log interno, nunca tela).
 */
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
  let inTok = 0
  let outTok = 0
  let rodadas = 0
  let custo = 0
  const modelosUsados: string[] = []
  let ultimo: ResultadoDiagnostico = { texto: "", inTok: 0, outTok: 0, rodadas: 0, resolvido: false }
  let modelo = cadeia[0] ?? ""
  let primeiroMapa = true

  for (const slug of cadeia) {
    modelo = slug
    modelosUsados.push(slug)
    onTroca(slug)
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
    )
    inTok += r.inTok
    outTok += r.outTok
    rodadas += r.rodadas
    custo += custoDe(slug, r.inTok, r.outTok)
    ultimo = r
    if (signal?.aborted) break
    if (!detectouHedge(r.texto)) break
    // Fail-fast (anti-400s/timeout): só escala pra um modelo MAIS CARO quando há COMPARAÇÃO PAREADA
    // precisa — o ponto forte da arquitetura, onde mais raciocínio de fato compensa (foi o que fez o
    // bug dos números cravar). Sem par (grep, ou superfície escopada sem divergência clara), uma
    // passada e devolve honesto: mais modelo não LOCALIZA melhor, só custa caro e arrisca timeout.
    if (material.pares.length === 0) break
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

/**
 * Fase 1 do diagnóstico: UMA passada de raciocínio (thinking ON) sobre o material já reunido.
 * Cospe o diagnóstico mastigado (causa raiz + correção) que o modelo rápido executa na fase 2.
 * Tira o raciocínio caro do loop agêntico — é uma pensada só, não seis.
 */
export async function raciocinarDiagnostico(
  input: string,
  dossie: string,
  model: Parameters<typeof generateText>[0]["model"],
  signal?: AbortSignal,
): Promise<{ texto: string; inTok: number; outTok: number }> {
  const r = await generateText({
    model,
    system: SISTEMA_RACIOCINIO,
    prompt: `SINTOMA:\n${input}\n\nTRECHOS DOS PONTOS QUE TOCAM NO SINTOMA:\n${dossie}\n\nCompare os caminhos e diagnostique.`,
    providerOptions: { openrouter: { reasoning: { effort: "high" } } },
    temperature: 0.2,
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
