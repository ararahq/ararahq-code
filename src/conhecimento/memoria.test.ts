import { test, expect, describe, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { montarRegistroBug, registrarBug, buscarPrecedente } from "./memoria"

describe("1.5 — montarRegistroBug", () => {
  test("extrai arquivo:linha do diagnóstico e correção dos editados", () => {
    const r = montarRegistroBug(
      "o estorno do cliente salva errado",
      "Causa raiz: o getter usa isShared em PoolService.kt:42 sem checar nulo.",
      ["src/PoolService.kt"],
    )
    expect(r.arquivoLinha).toBe("PoolService.kt:42")
    expect(r.correcao).toBe("editado: src/PoolService.kt")
    expect(r.sintoma).toBe("o estorno do cliente salva errado")
  })

  test("sem arquivo:linha no texto, cai no primeiro arquivo editado", () => {
    const r = montarRegistroBug("sintoma", "causa sem citar linha", ["a.ts", "b.ts"])
    expect(r.arquivoLinha).toBe("a.ts")
  })

  test("sem edição: correção marca 'verificado pelo build'", () => {
    const r = montarRegistroBug("sintoma", "só análise", [])
    expect(r.correcao).toBe("verificado pelo build")
    expect(r.arquivoLinha).toBe("")
  })

  test("trunca sintoma e causa longos", () => {
    const r = montarRegistroBug("s".repeat(500), "c".repeat(900), [])
    expect(r.sintoma.length).toBe(300)
    expect(r.causaRaiz.length).toBe(600)
  })
})

describe("1.5 — write-path round-trip (registrarBug -> buscarPrecedente)", () => {
  const homeOriginal = process.env.HOME
  let tmp: string | null = null

  afterEach(async () => {
    process.env.HOME = homeOriginal
    if (tmp) await rm(tmp, { recursive: true, force: true })
    tmp = null
  })

  test("um bug registrado é recuperado como precedente por similaridade", async () => {
    tmp = await mkdtemp(join(tmpdir(), "arara-mem-"))
    process.env.HOME = tmp
    const raiz = "/proj/exemplo"

    expect(await buscarPrecedente(raiz, "estorno do cliente salva errado")).toEqual([])

    await registrarBug(raiz, montarRegistroBug(
      "o estorno do cliente salva errado",
      "Causa: getter retorna o dedicated em PoolService.kt:42",
      ["src/PoolService.kt"],
    ))

    const prec = await buscarPrecedente(raiz, "por que o estorno do cliente salva errado")
    expect(prec.length).toBeGreaterThan(0)
    expect(prec[0].tipo).toBe("bug")
    expect(prec[0].item).toHaveProperty("arquivoLinha", "PoolService.kt:42")
  })
})
