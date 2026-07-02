import { describe, expect, test } from "bun:test"
import { extrairLocaisErro, dicaLocaisErro } from "./erros"

describe("extrairLocaisErro", () => {
  test("Kotlin/Gradle: e: file://...kt:linha:col — o caso real do ararahq-api", () => {
    const saida = [
      "> Task :compileTestKotlin FAILED",
      "e: file:///Users/x/api/src/test/kotlin/com/arara/api/services/AsyncServiceBehaviorTest.kt:96:13 No value passed for parameter 'twilioService'.",
      "e: file:///Users/x/api/src/test/kotlin/com/arara/api/services/InboundServiceTest.kt:62:13 No value passed for parameter 'twilioService'.",
      "BUILD FAILED in 2m 24s",
    ].join("\n")
    const locais = extrairLocaisErro(saida)
    expect(locais).toEqual([
      { arquivo: "/Users/x/api/src/test/kotlin/com/arara/api/services/AsyncServiceBehaviorTest.kt", linha: 96 },
      { arquivo: "/Users/x/api/src/test/kotlin/com/arara/api/services/InboundServiceTest.kt", linha: 62 },
    ])
  })

  test("TypeScript: arquivo(linha,col)", () => {
    expect(extrairLocaisErro("src/app.ts(12,5): error TS2345: Argument of type ...")).toEqual([
      { arquivo: "src/app.ts", linha: 12 },
    ])
  })

  test("Rust: --> src/main.rs:linha:col", () => {
    expect(extrairLocaisErro("error[E0308]: mismatched types\n --> src/main.rs:42:9")).toEqual([
      { arquivo: "src/main.rs", linha: 42 },
    ])
  })

  test("Python traceback: File \"...\", line N", () => {
    expect(extrairLocaisErro('  File "tests/test_wallet.py", line 88, in test_refund')).toEqual([
      { arquivo: "tests/test_wallet.py", linha: 88 },
    ])
  })

  test("dedup por arquivo:linha e respeita o teto", () => {
    const linhas = Array.from({ length: 10 }, (_, i) => `a/F${i}.kt:${i + 1}: error`).join("\n")
    const repetido = "a/F0.kt:1: error\n" + linhas
    const locais = extrairLocaisErro(repetido, 6)
    expect(locais.length).toBe(6)
    expect(locais.filter((l) => l.arquivo === "a/F0.kt" && l.linha === 1)).toHaveLength(1)
  })

  test("ignora ruído sem extensão de fonte (versões, tempos)", () => {
    expect(extrairLocaisErro("BUILD FAILED in 2m 24s\nGradle 8.5\nkotlin 2.0.21")).toEqual([])
  })
})

describe("dicaLocaisErro", () => {
  test("aponta os locais e avisa pra não editar arquivo de nome parecido", () => {
    const dica = dicaLocaisErro("e: file:///x/FooTest.kt:10:1 No value passed for parameter 'bar'")
    expect(dica).toContain("/x/FooTest.kt:10")
    expect(dica).toContain("presuma") // guardrail anti "erro no teste → edita o serviço"
  })

  test("sem local achado, dica vazia (não atrapalha o diagnóstico normal)", () => {
    expect(dicaLocaisErro("algo deu errado, sem arquivo:linha")).toBe("")
  })
})
