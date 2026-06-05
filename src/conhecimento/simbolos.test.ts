import { test, expect, describe } from "bun:test"
import { indiceReverso, type ArquivoSimbolos } from "./simbolos"

function arq(nome: string, ...simbolos: string[]): ArquivoSimbolos {
  return {
    arquivo: nome,
    linguagem: "Kotlin",
    imports: [],
    simbolos: simbolos.map((s) => ({
      nome: s,
      tipo: "metodo" as const,
      arquivo: nome,
      linhaInicio: 1,
      linhaFim: 2,
      assinatura: "",
      herda: [],
      chama: [],
      usaTipo: [],
    })),
  }
}

describe("indiceReverso — robusto a codebase alheio", () => {
  test("símbolo chamado 'constructor'/'toString'/'hasOwnProperty' não quebra (era crash em codebase real)", () => {
    const rev = indiceReverso([arq("A.kt", "constructor", "toString", "hasOwnProperty", "doWork")])
    expect(rev["constructor"]).toEqual(["A.kt"])
    expect(rev["toString"]).toEqual(["A.kt"])
    expect(rev["hasOwnProperty"]).toEqual(["A.kt"])
    expect(rev["doWork"]).toEqual(["A.kt"])
  })

  test("agrega arquivos por nome de símbolo", () => {
    const rev = indiceReverso([arq("A.kt", "save"), arq("B.kt", "save")])
    expect(rev["save"].sort()).toEqual(["A.kt", "B.kt"])
  })
})
