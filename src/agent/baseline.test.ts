import { describe, expect, test } from "bun:test"
import { assinaturaFalhas, compararComBaseline, rotuloFalha } from "./baseline"

describe("assinaturaFalhas", () => {
  test("captura locais de compilação e nomes de teste falhos (Gradle)", () => {
    const saida = [
      "e: file:///repo/src/test/FooTest.kt:96:13 No value passed for parameter 'x'.",
      "com.arara.api.InAppNotificationControllerTest > unreadCount deve usar no-store() FAILED",
      "BUILD FAILED",
    ].join("\n")
    const a = assinaturaFalhas(saida)
    expect(a.has("loc:/repo/src/test/FooTest.kt:96")).toBe(true)
    expect([...a].some((f) => f.startsWith("teste:com.arara.api.InAppNotificationControllerTest"))).toBe(true)
  })

  test("saída verde não tem falhas", () => {
    expect(assinaturaFalhas("BUILD SUCCESSFUL in 18s").size).toBe(0)
  })
})

describe("compararComBaseline", () => {

  const baselineSemCompilar = assinaturaFalhas("e: file:///r/FooTest.kt:96:13 No value passed for parameter 'x'.")

  const baselineCompilava = assinaturaFalhas("com.x.FlakyTest > jaFalhava() FAILED")

  test("o CASO REAL v3: baseline não compilava; após consertar, sobra falha de RUNTIME → indeterminado", () => {

    const v = compararComBaseline(baselineSemCompilar, "com.x.ControllerTest > deveUsarNoStore() FAILED\nBUILD FAILED")
    expect(v.tipo).toBe("indeterminado")
    if (v.tipo === "indeterminado") expect(v.naoAtribuiveis.some((f) => f.includes("ControllerTest"))).toBe(true)
  })

  test("baseline compilava e já tinha o teste falhando → mesmo teste falhar depois = sem-piora", () => {
    const v = compararComBaseline(baselineCompilava, "com.x.FlakyTest > jaFalhava() FAILED")
    expect(v.tipo).toBe("sem-piora")
  })

  test("baseline compilava + edição INTRODUZ falha nova → piorou, listando só a nova (atribuível)", () => {
    const v = compararComBaseline(baselineCompilava, [
      "com.x.FlakyTest > jaFalhava() FAILED",
      "com.x.NovoTest > queEuQuebrei() FAILED",
    ].join("\n"))
    expect(v.tipo).toBe("piorou")
    if (v.tipo === "piorou") {
      expect(v.novas.some((f) => f.includes("NovoTest"))).toBe(true)
      expect(v.novas.some((f) => f.includes("FlakyTest"))).toBe(false)
    }
  })

  test("edição que INTRODUZ erro de COMPILAÇÃO novo → piorou (compilação é sempre atribuível)", () => {
    const v = compararComBaseline(baselineSemCompilar, "e: file:///r/Novo.kt:10:1 erro que eu criei\nBUILD FAILED")
    expect(v.tipo).toBe("piorou")
    if (v.tipo === "piorou") expect(v.novas.some((f) => f.includes("Novo.kt"))).toBe(true)
  })

  test("tudo resolvido → sem-piora com lista vazia (o gate acima trata como verde)", () => {
    expect(compararComBaseline(baselineSemCompilar, "BUILD SUCCESSFUL")).toEqual({ tipo: "sem-piora", preExistentes: [] })
  })
})

describe("rotuloFalha", () => {
  test("tira o prefixo de tipo pra exibição", () => {
    expect(rotuloFalha("loc:src/a.kt:96")).toBe("src/a.kt:96")
    expect(rotuloFalha("teste:com.x.Y>z()")).toBe("com.x.Y>z()")
  })
})
