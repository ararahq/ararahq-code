import { describe, expect, test } from "bun:test"
import { pareceConsertarBuild, montarTarefaAterrada, aterrarPorBuild } from "./grounding"

describe("pareceConsertarBuild", () => {
  test("casa 'faça os testes passarem' e variantes", () => {
    expect(pareceConsertarBuild("Faça todos os testes do projeto compilarem e passarem")).toBe(true)
    expect(pareceConsertarBuild("os testes não estão passando, conserta")).toBe(true)
    expect(pareceConsertarBuild("deixa o build verde")).toBe(true)
    expect(pareceConsertarBuild("make the tests pass")).toBe(true)
    expect(pareceConsertarBuild("o CI está vermelho, arruma")).toBe(true)
  })

  test("NÃO casa tarefa que não é de build/teste", () => {
    expect(pareceConsertarBuild("adiciona o campo isActive no User")).toBe(false)
    expect(pareceConsertarBuild("por que o cache não invalida?")).toBe(false)
    expect(pareceConsertarBuild("renomeia a função foo")).toBe(false)
  })

  test("alvo sem ação (ou vice-versa) não basta", () => {
    expect(pareceConsertarBuild("escreve um teste novo pro serviço")).toBe(false) // teste, mas sem ação de consertar
    expect(pareceConsertarBuild("conserta o layout do header")).toBe(false) // conserta, mas sem alvo build/teste
  })
})

describe("montarTarefaAterrada", () => {
  test("lista os locais, inclui trechos e o guardrail anti arquivo-de-nome-parecido", () => {
    const t = montarTarefaAterrada("faça os testes passarem", [
      { arquivo: "src/test/FooTest.kt", linha: 96, trecho: "96\tval s = InboundService()" },
      { arquivo: "src/test/BarTest.kt", linha: 62, trecho: null },
    ])
    expect(t).toContain("src/test/FooTest.kt:96")
    expect(t).toContain("src/test/BarTest.kt:62")
    expect(t).toContain("InboundService()") // trecho embutido
    expect(t).toContain("no próprio teste, não no serviço de produção") // guardrail
    expect(t).toContain("faça os testes passarem") // pedido original preservado
  })
})

describe("aterrarPorBuild", () => {
  const deps = (code: number, saida: string) => ({
    raiz: "/repo",
    comando: "./gradlew test",
    rodar: async () => ({ code, saida }),
    lerTrecho: async (arquivo: string, linha: number) => `${linha}\t// ${arquivo}`,
  })

  test("build verde → ja-verde (nada a consertar)", async () => {
    const r = await aterrarPorBuild("faz os testes passar", deps(0, "BUILD SUCCESSFUL"))
    expect(r).toEqual({ tipo: "ja-verde" })
  })

  test("build vermelho com locais → aterrado, paths normalizados pra relativos à raiz", async () => {
    const saida = [
      "> Task :compileTestKotlin FAILED",
      "e: file:///repo/src/test/kotlin/FooTest.kt:96:13 No value passed for parameter 'twilioService'.",
      "e: file:///repo/src/test/kotlin/BarTest.kt:62:13 No value passed for parameter 'twilioService'.",
    ].join("\n")
    const r = await aterrarPorBuild("faz os testes passar", deps(1, saida))
    expect(r?.tipo).toBe("aterrado")
    if (r?.tipo === "aterrado") {
      expect(r.arquivos).toEqual(["src/test/kotlin/FooTest.kt", "src/test/kotlin/BarTest.kt"])
      expect(r.tarefa).toContain("src/test/kotlin/FooTest.kt:96")
      expect(r.tarefa).not.toContain("/repo/") // normalizado, sem prefixo absoluto
    }
  })

  test("build vermelho SEM local extraível → null (deixa o diagnóstico normal assumir)", async () => {
    const r = await aterrarPorBuild("faz os testes passar", deps(1, "algo quebrou, sem arquivo:linha"))
    expect(r).toBeNull()
  })

  test("sem comando de gate determinável → null", async () => {
    const r = await aterrarPorBuild("faz os testes passar", { ...deps(1, "x"), comando: null })
    expect(r).toBeNull()
  })
})
