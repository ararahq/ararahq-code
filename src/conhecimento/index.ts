import { lerJson, gravarJson } from "./armazenamento"
import { listarFontes, type ArquivoFonte } from "./walk"
import { detectarStack, type ProjectInfo } from "./stack"
import { extrairSimbolos, indiceReverso, type ArquivoSimbolos } from "./simbolos"
import { construirGrafo, Grafo, type GrafoSerial } from "./grafo"

export type { ProjectInfo } from "./stack"
export type { ArquivoSimbolos, Simbolo, Import } from "./simbolos"
export { Grafo } from "./grafo"
export type { No, Aresta, TipoAresta, GrafoSerial } from "./grafo"

const F_PROJECT = "project.json"
const F_SIMBOLOS = "simbolos.json"
const F_GRAFO = "grafo.json"

type EntradaSimbolos = ArquivoSimbolos & { mtimeMs: number; hash: string }
type SimbolosPersistido = { entradas: EntradaSimbolos[] }

export type Indice = {
  raiz: string
  project: ProjectInfo
  simbolos: ArquivoSimbolos[]
  reverso: Record<string, string[]>
  grafo: Grafo
  grafoSerial: GrafoSerial
  stats: { arquivos: number; simbolos: number; reprocessados: number; reusados: number }
}

function hashConteudo(texto: string): string {
  return Bun.hash(texto).toString(16)
}

/** Lê e extrai símbolos de um arquivo. Degrada pra entrada vazia (sem crashar) em erro de I/O. */
async function processarArquivo(raiz: string, f: ArquivoFonte): Promise<EntradaSimbolos | null> {
  try {
    const texto = await Bun.file(`${raiz}/${f.caminho}`).text()
    const sym = extrairSimbolos(f.caminho, texto)
    return { ...sym, mtimeMs: f.mtimeMs, hash: hashConteudo(texto) }
  } catch {
    return null
  }
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
    .map(({ mtimeMs: _m, hash: _h, ...rest }) => rest)
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
  const simbolos: ArquivoSimbolos[] = persistido.entradas.map(({ mtimeMs: _m, hash: _h, ...rest }) => rest)
  const grafoSerial = await lerJson<GrafoSerial>(raiz, F_GRAFO, { nos: [], arestas: [] })
  return {
    raiz,
    project,
    simbolos,
    reverso: indiceReverso(simbolos),
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
  carregarMemoria, registrarBug, registrarDecisao, registrarPadrao, buscarPrecedente,
} from "./memoria"
export type { Memoria, Bug, Decisao, Padrao, Precedente } from "./memoria"
export { gerarResumos, carregarResumos, type ResumirFn, type CacheResumos } from "./resumos"
export { detectarStack } from "./stack"
