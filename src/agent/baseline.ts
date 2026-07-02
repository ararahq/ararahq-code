import { extrairLocaisErro } from "./erros"

const RE_TESTE_GRADLE = /^\s*([\w.$]+)\s*>\s*([\w$()., -]+?)\s+FAILED\s*$/
const RE_TESTE_GENERICO = /^\s*[✕✗x]\s+(.{5,120})$/

export function assinaturaFalhas(saida: string): Set<string> {
  const assin = new Set<string>()
  for (const l of extrairLocaisErro(saida, 50)) assin.add(`loc:${l.arquivo}:${l.linha}`)
  for (const linha of saida.split("\n")) {
    const g = linha.match(RE_TESTE_GRADLE)
    if (g) {
      assin.add(`teste:${g[1]}>${g[2].trim()}`)
      continue
    }
    const x = linha.match(RE_TESTE_GENERICO)
    if (x) assin.add(`teste:${x[1].trim()}`)
  }
  return assin
}

export type Veredito =
  | { tipo: "sem-piora"; preExistentes: string[] }
  | { tipo: "piorou"; novas: string[]; preExistentes: string[] }

  | { tipo: "indeterminado"; naoAtribuiveis: string[]; preExistentes: string[] }

function ehLoc(f: string): boolean {
  return f.startsWith("loc:")
}

export function compararComBaseline(baseline: Set<string>, saidaFinal: string): Veredito {
  const finais = assinaturaFalhas(saidaFinal)
  const novas: string[] = []
  const preExistentes: string[] = []
  for (const f of finais) (baseline.has(f) ? preExistentes : novas).push(f)
  if (!novas.length) return { tipo: "sem-piora", preExistentes }

  const baselineNaoCompilava = [...baseline].some(ehLoc)

  const novasCompilacao = novas.filter(ehLoc)
  const novasRuntime = novas.filter((f) => !ehLoc(f))
  if (baselineNaoCompilava && !novasCompilacao.length && novasRuntime.length) {
    return { tipo: "indeterminado", naoAtribuiveis: novasRuntime, preExistentes }
  }
  return { tipo: "piorou", novas, preExistentes }
}

let _baseline: Set<string> | null = null

export function registrarBaseline(saida: string): void {
  _baseline = assinaturaFalhas(saida)
}

export function baselineAtual(): Set<string> | null {
  return _baseline
}

export function resetBaseline(): void {
  _baseline = null
}

export function rotuloFalha(assinatura: string): string {
  return assinatura.replace(/^(loc|teste):/, "")
}
