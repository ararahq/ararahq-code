import { lerJson, gravarJson } from "./armazenamento"
import { listarFontes, type ArquivoFonte } from "./walk"
import { detectarStack, type ProjectInfo } from "./stack"
import { extrairSimbolos, indiceReverso, type ArquivoSimbolos } from "./simbolos"
import { construirGrafo, Grafo, type GrafoSerial } from "./grafo"
import { perfilTermos } from "../engine/marques"

export type { ProjectInfo } from "./stack"
export type { ArquivoSimbolos, Simbolo, Import } from "./simbolos"
export { Grafo } from "./grafo"
export type { No, Aresta, TipoAresta, GrafoSerial } from "./grafo"

const F_PROJECT = "project.json"
const F_SIMBOLOS = "simbolos.json"
const F_GRAFO = "grafo.json"

// Perfil de termos do CONTEÚDO do arquivo (1.2-conteúdo): top termos por frequência (Marques). É o que
// liga o sintoma do leigo a um arquivo cujo BUG está numa constante/config/valor — coisa que o mapa de
// símbolos (só classe/função) não enxerga. Persistido com o símbolo, recomputado só quando o arquivo muda.
const MAX_TERMOS_ARQUIVO = 50

type EntradaSimbolos = ArquivoSimbolos & { mtimeMs: number; hash: string; termos: [string, number][] }
type SimbolosPersistido = { entradas: EntradaSimbolos[] }

export type Indice = {
  raiz: string
  project: ProjectInfo
  simbolos: ArquivoSimbolos[]
  reverso: Record<string, string[]>
  // arquivo -> top termos do conteúdo [termo, frequência]. Base do retrieval por termos (Camada 2).
  termos: Record<string, [string, number][]>
  grafo: Grafo
  grafoSerial: GrafoSerial
  stats: { arquivos: number; simbolos: number; reprocessados: number; reusados: number }
}

function hashConteudo(texto: string): string {
  return Bun.hash(texto).toString(16)
}

function topTermos(texto: string): [string, number][] {
  return [...perfilTermos(texto).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TERMOS_ARQUIVO)
}

/** Lê e extrai símbolos + perfil de termos de um arquivo. Degrada pra null (sem crashar) em erro de I/O. */
async function processarArquivo(raiz: string, f: ArquivoFonte): Promise<EntradaSimbolos | null> {
  try {
    const texto = await Bun.file(`${raiz}/${f.caminho}`).text()
    const sym = extrairSimbolos(f.caminho, texto)
    return { ...sym, mtimeMs: f.mtimeMs, hash: hashConteudo(texto), termos: topTermos(texto) }
  } catch {
    return null
  }
}

/** Mapa arquivo -> termos do conteúdo, só dos arquivos presentes. Entradas de cache antigo (sem termos) viram []. */
function mapaTermos(entradas: EntradaSimbolos[], presentes: Set<string>): Record<string, [string, number][]> {
  const out: Record<string, [string, number][]> = {}
  for (const e of entradas) if (presentes.has(e.arquivo)) out[e.arquivo] = e.termos ?? []
  return out
}

/**
 * Indexa o projeto (Camada 1). 1ª vez constrói tudo; nas seguintes só reprocessa arquivos cujo
 * mtime mudou (e confirma por hash de conteúdo) — os demais reusam o mapa simbólico em cache.
 * Sempre reconstrói o grafo a partir do mapa simbólico completo (O(símbolos), em memória, rápido).
 * Persiste project.json, simbolos.json e grafo.json. `force` reprocessa tudo do zero.
 */
export async function indexar(raiz: string, opts: { force?: boolean } = {}): Promise<Indice> {
  const project = await detectarStack(raiz)
  const fontes = await listarFontes(raiz)

  const cache = opts.force
    ? new Map<string, EntradaSimbolos>()
    : new Map((await lerJson<SimbolosPersistido>(raiz, F_SIMBOLOS, { entradas: [] })).entradas.map((e) => [e.arquivo, e]))

  const entradas: EntradaSimbolos[] = []
  let reprocessados = 0
  let reusados = 0
  const presentes = new Set(fontes.map((f) => f.caminho))

  for (const f of fontes) {
    const anterior = cache.get(f.caminho)
    if (anterior && anterior.mtimeMs === f.mtimeMs) {
      entradas.push(anterior)
      reusados++
      continue
    }
    const proc = await processarArquivo(raiz, f)
    if (!proc) {
      if (anterior) {
        entradas.push(anterior)
        reusados++
      }
      continue
    }
    if (anterior && anterior.hash === proc.hash) {
      entradas.push({ ...anterior, mtimeMs: f.mtimeMs })
      reusados++
      continue
    }
    entradas.push(proc)
    reprocessados++
  }

  const simbolos: ArquivoSimbolos[] = entradas
    .filter((e) => presentes.has(e.arquivo))
    .map(({ mtimeMs: _m, hash: _h, termos: _t, ...rest }) => rest)
  const reverso = indiceReverso(simbolos)
  const grafoSerial = construirGrafo(simbolos)

  await Promise.all([
    gravarJson(raiz, F_PROJECT, project),
    gravarJson(raiz, F_SIMBOLOS, { entradas }),
    gravarJson(raiz, F_GRAFO, grafoSerial),
  ])

  return {
    raiz,
    project,
    simbolos,
    reverso,
    termos: mapaTermos(entradas, presentes),
    grafo: new Grafo(grafoSerial),
    grafoSerial,
    stats: {
      arquivos: simbolos.length,
      simbolos: simbolos.reduce((s, a) => s + a.simbolos.length, 0),
      reprocessados,
      reusados,
    },
  }
}

/**
 * Carrega o índice persistido sem reprocessar arquivos. Retorna null se ainda não foi indexado.
 * Pra garantir frescor, o app chama `indexar` (que é barato no caminho incremental).
 */
export async function carregarIndice(raiz: string): Promise<Indice | null> {
  const project = await lerJson<ProjectInfo | null>(raiz, F_PROJECT, null)
  if (!project) return null
  const persistido = await lerJson<SimbolosPersistido>(raiz, F_SIMBOLOS, { entradas: [] })
  const simbolos: ArquivoSimbolos[] = persistido.entradas.map(({ mtimeMs: _m, hash: _h, termos: _t, ...rest }) => rest)
  const presentes = new Set(persistido.entradas.map((e) => e.arquivo))
  const grafoSerial = await lerJson<GrafoSerial>(raiz, F_GRAFO, { nos: [], arestas: [] })
  return {
    raiz,
    project,
    simbolos,
    reverso: indiceReverso(simbolos),
    termos: mapaTermos(persistido.entradas, presentes),
    grafo: new Grafo(grafoSerial),
    grafoSerial,
    stats: {
      arquivos: simbolos.length,
      simbolos: simbolos.reduce((s, a) => s + a.simbolos.length, 0),
      reprocessados: 0,
      reusados: simbolos.length,
    },
  }
}

export {
  carregarMemoria, registrarBug, registrarDecisao, registrarPadrao, buscarPrecedente, montarRegistroBug,
} from "./memoria"
export type { Memoria, Bug, Decisao, Padrao, Precedente } from "./memoria"
export { gerarResumos, carregarResumos, type ResumirFn, type CacheResumos } from "./resumos"
export { detectarStack } from "./stack"
