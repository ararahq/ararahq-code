import { test, expect, describe } from "bun:test"
import { interpretarVeredito, extrairCausaAlvo } from "./verificador"

describe("verificador — extrairCausaAlvo (arquivo:linha da conclusão)", () => {
  test("pega arquivo e linha da linha CAUSA (com bold/preâmbulo)", () => {
    expect(extrairCausaAlvo("CAUSA: src/infra/Mutex.kt:23 — TOCTOU")).toEqual({ arquivo: "src/infra/Mutex.kt", linha: 23 })
    expect(extrairCausaAlvo("Preâmbulo.\n\n**CAUSA:** a/b/Foo.ts:128 — x")).toEqual({ arquivo: "a/b/Foo.ts", linha: 128 })
  })
  test("null quando não há arquivo:linha (sem ponto pra verificar → não escala)", () => {
    expect(extrairCausaAlvo("CAUSA: o problema é de concorrência no lock")).toBeNull()
    expect(extrairCausaAlvo("NÃO CRAVEI: prováveis a.ts, b.ts")).toBeNull()
  })
})

describe("verificador — interpretarVeredito (cético: só SIM confirma)", () => {
  test("SIM na 1ª linha confirma", () => {
    expect(interpretarVeredito("SIM\no lock não é atômico, dois nós entram")).toBe(true)
    expect(interpretarVeredito("sim, claramente.")).toBe(true)
  })

  test("NAO/NÃO não confirma", () => {
    expect(interpretarVeredito("NAO\nesse código não tem relação com o sintoma")).toBe(false)
    expect(interpretarVeredito("NÃO, é outro bug")).toBe(false)
  })

  test("prosa sem veredito claro não confirma (na dúvida, NAO)", () => {
    expect(interpretarVeredito("talvez, mas não tenho certeza")).toBe(false)
    expect(interpretarVeredito("")).toBe(false)
  })

  test("não confunde 'sim' no meio de outra palavra", () => {
    expect(interpretarVeredito("simplesmente não dá pra afirmar")).toBe(false)
  })
})
