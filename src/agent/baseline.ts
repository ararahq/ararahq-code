import { extrairLocaisErro } from "./erros"

// Baseline gate: o repo pode JÁ chegar quebrado (WIP do usuário, quebra commitada por outro). Sem
// baseline, o portão final imputa essa quebra à edição da Jade — "vermelho" injusto que assusta e
// vira PR "parcial" errado. Aqui: captura a ASSINATURA das falhas ANTES da primeira edição (o
// grounding-por-build já roda o build de graça nesse momento) e, no portão final, compara. Falha
// que já existia não é culpa da edição; falha NOVA é. Determinístico, zero modelo.

// Padrões de teste que FALHOU por runner (nome do teste, não local de compilação):
// Gradle/JUnit: "com.x.FooTest > deveCriar() FAILED" · genérico: "FAILED"/"✕"/"✗ nome"
const RE_TESTE_GRADLE = /^\s*([\w.$]+)\s*>\s*([\w$()., -]+?)\s+FAILED\s*$/
const RE_TESTE_GENERICO = /^\s*[✕✗x]\s+(.{5,120})$/

/**
 * Assinatura do conjunto de falhas de uma saída de build/teste: locais de erro de compilação
 * (arquivo:linha via erros.ts) + nomes de testes que falharam. É o "conjunto de coisas quebradas"
 * comparável entre antes/depois. Pura, testável.
 */
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
  | { tipo: "sem-piora"; preExistentes: string[] } // tudo que falha já falhava antes
  | { tipo: "piorou"; novas: string[]; preExistentes: string[] } // a edição introduziu falha NOVA (baseline via)
  // baseline NÃO compilava, então não pôde rodar os testes: as falhas de runtime que aparecem depois
  // do conserto de compilação NÃO dá pra atribuir (podem já existir, mascaradas). Honesto: não afirma.
  | { tipo: "indeterminado"; naoAtribuiveis: string[]; preExistentes: string[] }

function ehLoc(f: string): boolean {
  return f.startsWith("loc:")
}

/**
 * Compara as falhas do portão final com o baseline. Pura, testável. O ponto sutil: se o baseline
 * FALHAVA na compilação (tem `loc:`), ele nunca chegou a rodar os testes — então uma falha de teste
 * (`teste:`) nova NÃO é necessariamente culpa da edição (pode estar mascarada). Nesse caso o veredito
 * é `indeterminado`, não `piorou` — a Jade conserta a compilação e diz a verdade sobre o resto.
 */
export function compararComBaseline(baseline: Set<string>, saidaFinal: string): Veredito {
  const finais = assinaturaFalhas(saidaFinal)
  const novas: string[] = []
  const preExistentes: string[] = []
  for (const f of finais) (baseline.has(f) ? preExistentes : novas).push(f)
  if (!novas.length) return { tipo: "sem-piora", preExistentes }

  const baselineNaoCompilava = [...baseline].some(ehLoc)
  // Falhas novas que são de TESTE (runtime): só elas ficam mascaradas por um baseline que não compila.
  // Uma falha nova de COMPILAÇÃO (`loc:`) SIM é culpa da edição — o baseline compilava aquele ponto.
  const novasCompilacao = novas.filter(ehLoc)
  const novasRuntime = novas.filter((f) => !ehLoc(f))
  if (baselineNaoCompilava && !novasCompilacao.length && novasRuntime.length) {
    return { tipo: "indeterminado", naoAtribuiveis: novasRuntime, preExistentes }
  }
  return { tipo: "piorou", novas, preExistentes }
}

// Estado por tarefa (mesmo ciclo de vida dos trackers da Camada 4: reset em novaRodada).
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

/** Legível pro relatório: "loc:src/a.kt:96" -> "src/a.kt:96" · "teste:X>y() " -> "X>y()". */
export function rotuloFalha(assinatura: string): string {
  return assinatura.replace(/^(loc|teste):/, "")
}
