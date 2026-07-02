import type { ArquivoSimbolos } from "./simbolos"

export type TipoAresta = "IMPORTA" | "CHAMA" | "HERDA" | "USA_TIPO"
export type TipoNo = "arquivo" | "simbolo"

export type No = { id: string; tipo: TipoNo; nome: string; arquivo: string }
export type Aresta = { de: string; para: string; tipo: TipoAresta }

export type GrafoSerial = { nos: No[]; arestas: Aresta[] }

const NO_ARQUIVO = (arquivo: string): string => `f:${arquivo}`
const NO_SIMBOLO = (arquivo: string, nome: string): string => `s:${arquivo}#${nome}`

const EXTS_TENTATIVA = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"]

function resolverRelativo(origem: string, alvo: string, arquivos: Set<string>): string | null {
  const baseDir = origem.includes("/") ? origem.slice(0, origem.lastIndexOf("/")) : ""
  const partes = `${baseDir}/${alvo}`.split("/")
  const pilha: string[] = []
  for (const p of partes) {
    if (p === "" || p === ".") continue
    if (p === "..") pilha.pop()
    else pilha.push(p)
  }
  const semExt = pilha.join("/")
  for (const ext of EXTS_TENTATIVA) {
    const cand = `${semExt}${ext}`
    if (arquivos.has(cand)) return cand
  }
  return null
}

export function construirGrafo(fontes: ArquivoSimbolos[]): GrafoSerial {
  const arquivos = new Set(fontes.map((f) => f.arquivo))
  const nos = new Map<string, No>()
  const arestas: Aresta[] = []
  const vistas = new Set<string>()
  const defPorNome = new Map<string, { arquivo: string; nome: string }[]>()

  for (const f of fontes) {
    nos.set(NO_ARQUIVO(f.arquivo), { id: NO_ARQUIVO(f.arquivo), tipo: "arquivo", nome: f.arquivo, arquivo: f.arquivo })
    for (const s of f.simbolos) {
      nos.set(NO_SIMBOLO(s.arquivo, s.nome), { id: NO_SIMBOLO(s.arquivo, s.nome), tipo: "simbolo", nome: s.nome, arquivo: s.arquivo })
      const lista = defPorNome.get(s.nome) ?? []
      lista.push({ arquivo: s.arquivo, nome: s.nome })
      defPorNome.set(s.nome, lista)
    }
  }

  const ligar = (de: string, para: string, tipo: TipoAresta) => {
    if (de === para || !nos.has(de) || !nos.has(para)) return
    const chave = `${de}->${para}:${tipo}`
    if (vistas.has(chave)) return
    vistas.add(chave)
    arestas.push({ de, para, tipo })
  }

  const resolver = (nome: string, arquivoOrigem: string, arquivosImportados: Set<string>): string | null => {
    const defs = defPorNome.get(nome)
    if (!defs?.length) return null
    const local = defs.find((d) => d.arquivo === arquivoOrigem)
    if (local) return NO_SIMBOLO(local.arquivo, local.nome)
    if (defs.length === 1 && arquivosImportados.has(defs[0].arquivo)) {
      return NO_SIMBOLO(defs[0].arquivo, defs[0].nome)
    }
    return null
  }

  for (const f of fontes) {
    const importados = new Map<string, string>()
    const arquivosImportados = new Set<string>()
    for (const imp of f.imports) {
      if (imp.alvo.startsWith(".")) {
        const destino = resolverRelativo(f.arquivo, imp.alvo, arquivos)
        if (destino) {
          ligar(NO_ARQUIVO(f.arquivo), NO_ARQUIVO(destino), "IMPORTA")
          arquivosImportados.add(destino)
        }
        continue
      }
      for (const nome of imp.nomes) {
        const defs = defPorNome.get(nome)
        if (defs?.length === 1) {
          ligar(NO_ARQUIVO(f.arquivo), NO_ARQUIVO(defs[0].arquivo), "IMPORTA")
          importados.set(nome, NO_SIMBOLO(defs[0].arquivo, defs[0].nome))
          arquivosImportados.add(defs[0].arquivo)
        }
      }
    }

    for (const s of f.simbolos) {
      const id = NO_SIMBOLO(s.arquivo, s.nome)
      for (const pai of s.herda) {
        const idPai = resolver(pai, f.arquivo, arquivosImportados) ?? importados.get(pai)
        if (idPai) ligar(id, idPai, "HERDA")
      }
      for (const chamada of s.chama) {
        const idAlvo = resolver(chamada, f.arquivo, arquivosImportados)
        if (idAlvo) ligar(id, idAlvo, "CHAMA")
        else if (importados.has(chamada)) ligar(id, importados.get(chamada)!, "USA_TIPO")
      }
      for (const tipo of s.usaTipo) {
        const idTipo = importados.get(tipo) ?? resolver(tipo, f.arquivo, arquivosImportados)
        if (idTipo) ligar(id, idTipo, "USA_TIPO")
      }
    }
  }

  return { nos: [...nos.values()], arestas }
}

export type Caminho = { passos: No[] }

export class Grafo {
  private readonly nos: Map<string, No>
  private readonly saida: Map<string, Aresta[]>
  private readonly entrada: Map<string, Aresta[]>

  constructor(serial: GrafoSerial) {
    this.nos = new Map(serial.nos.map((n) => [n.id, n]))
    this.saida = new Map()
    this.entrada = new Map()
    for (const a of serial.arestas) {
      this.push(this.saida, a.de, a)
      this.push(this.entrada, a.para, a)
    }
  }

  private push(mapa: Map<string, Aresta[]>, chave: string, a: Aresta): void {
    const lista = mapa.get(chave)
    if (lista) lista.push(a)
    else mapa.set(chave, [a])
  }

  no(id: string): No | undefined {
    return this.nos.get(id)
  }

  get tamanho(): { nos: number; arestas: number } {
    let arestas = 0
    for (const l of this.saida.values()) arestas += l.length
    return { nos: this.nos.size, arestas }
  }

  resolver(ref: string): string | null {
    if (this.nos.has(ref)) return ref
    if (ref.includes("#")) {
      const [arq, nome] = ref.split("#")
      const id = NO_SIMBOLO(arq, nome)
      if (this.nos.has(id)) return id
    }
    const comoArquivo = NO_ARQUIVO(ref)
    if (this.nos.has(comoArquivo)) return comoArquivo
    for (const n of this.nos.values()) {
      if (n.tipo === "simbolo" && n.nome === ref) return n.id
    }
    return null
  }

  vizinhos(id: string): { aresta: Aresta; no: No }[] {
    const alvo = this.resolver(id)
    if (!alvo) return []
    const out: { aresta: Aresta; no: No }[] = []
    for (const a of this.saida.get(alvo) ?? []) {
      const no = this.nos.get(a.para)
      if (no) out.push({ aresta: a, no })
    }
    return out
  }

  caminharPraTras(id: string, profundidade = 3): { no: No; nivel: number; via: TipoAresta }[] {
    const alvo = this.resolver(id)
    if (!alvo) return []
    const visto = new Set<string>([alvo])
    const out: { no: No; nivel: number; via: TipoAresta }[] = []
    let fronteira = [alvo]
    for (let nivel = 1; nivel <= profundidade && fronteira.length; nivel++) {
      const proxima: string[] = []
      for (const atual of fronteira) {
        for (const a of this.entrada.get(atual) ?? []) {
          if (visto.has(a.de)) continue
          visto.add(a.de)
          const no = this.nos.get(a.de)
          if (!no) continue
          out.push({ no, nivel, via: a.tipo })
          proxima.push(a.de)
        }
      }
      fronteira = proxima
    }
    return out
  }

  caminho(a: string, b: string): Caminho | null {
    const origem = this.resolver(a)
    const destino = this.resolver(b)
    if (!origem || !destino) return null
    if (origem === destino) return { passos: [this.nos.get(origem)!] }
    const anterior = new Map<string, string>()
    const fila = [origem]
    const visto = new Set([origem])
    while (fila.length) {
      const atual = fila.shift()!
      for (const ar of this.saida.get(atual) ?? []) {
        if (visto.has(ar.para)) continue
        visto.add(ar.para)
        anterior.set(ar.para, atual)
        if (ar.para === destino) return { passos: this.reconstruir(anterior, origem, destino) }
        fila.push(ar.para)
      }
    }
    return null
  }

  private reconstruir(anterior: Map<string, string>, origem: string, destino: string): No[] {
    const ids: string[] = [destino]
    let atual = destino
    while (atual !== origem) {
      atual = anterior.get(atual)!
      ids.push(atual)
    }
    return ids.reverse().map((i) => this.nos.get(i)!)
  }

  componentesDo(simbolo: string): {
    centro: No
    usa: { no: No; via: TipoAresta }[]
    usadoPor: { no: No; via: TipoAresta }[]
  } | null {
    const id = this.resolver(simbolo)
    if (!id) return null
    const centro = this.nos.get(id)!
    const usa: { no: No; via: TipoAresta }[] = []
    for (const a of this.saida.get(id) ?? []) {
      const no = this.nos.get(a.para)
      if (no) usa.push({ no, via: a.tipo })
    }
    const usadoPor: { no: No; via: TipoAresta }[] = []
    for (const a of this.entrada.get(id) ?? []) {
      const no = this.nos.get(a.de)
      if (no) usadoPor.push({ no, via: a.tipo })
    }
    return { centro, usa, usadoPor }
  }
}
