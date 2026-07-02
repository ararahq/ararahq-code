export type IndiceParaRef = {
  simbolos: { arquivo: string }[]
  reverso: Record<string, string[]>
}

const RE_ARQUIVO_FONTE = /[\w./-]*\w\.[A-Za-z][A-Za-z0-9]{1,9}\b/
const RE_ARQUIVO_FONTE_G = /[\w./-]*\w\.[A-Za-z][A-Za-z0-9]{1,9}\b/g

const RE_CAMINHO = /\b[\w-]+\/[\w./-]+/

const RE_IDENT = /\b[a-z][a-z0-9]*[A-Z]\w*|\b(?:[A-Z][a-z0-9]+){2,}\b/

const RE_CHAMADA = /\b\w+\(/

const RE_EXCECAO = /\b[A-Z]\w*(?:Exception|Error)\b/

function tokens(input: string): string[] {
  return input.split(/[^\w./-]+/).filter(Boolean)
}

export function refsNoIndice(input: string, indice: IndiceParaRef): string[] {
  const arquivos = new Set<string>()
  const bases = new Set<string>()
  for (const a of indice.simbolos) {
    arquivos.add(a.arquivo)
    const base = a.arquivo.split("/").pop()
    if (base) bases.add(base)
  }
  const simbolos = new Set(Object.keys(indice.reverso))
  const out = new Set<string>()
  for (const t of tokens(input)) {
    const base = t.split("/").pop() ?? t
    if (arquivos.has(t) || bases.has(t) || bases.has(base) || simbolos.has(t)) out.add(t)
  }
  return [...out]
}

export function pareceReferenciaCodigo(input: string, indice?: IndiceParaRef): boolean {
  if (indice && refsNoIndice(input, indice).length > 0) return true
  return (
    RE_ARQUIVO_FONTE.test(input) ||
    RE_CAMINHO.test(input) ||
    RE_IDENT.test(input) ||
    RE_CHAMADA.test(input) ||
    RE_EXCECAO.test(input)
  )
}

export function extrairArquivosCitados(input: string): string[] {
  const out: string[] = []
  const vistos = new Set<string>()
  for (const m of input.matchAll(RE_ARQUIVO_FONTE_G)) {
    const arq = m[0].replace(/^\.\//, "")
    if (!vistos.has(arq)) {
      vistos.add(arq)
      out.push(arq)
    }
  }
  return out
}
