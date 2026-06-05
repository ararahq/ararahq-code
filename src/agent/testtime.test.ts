import { test, expect, describe } from "bun:test"
import { selecionarPorVerificacao } from "./testtime"

describe("3.4 — selecionarPorVerificacao", () => {
  test("gera os N candidatos em paralelo", async () => {
    const gerados: number[] = []
    await selecionarPorVerificacao(
      3,
      async (i) => {
        gerados.push(i)
        return i
      },
      async () => false,
      async () => {},
    )
    expect(gerados.sort()).toEqual([0, 1, 2])
  })

  test("o primeiro que verifica verde ganha; os seguintes não são verificados", async () => {
    const verificados: number[] = []
    const r = await selecionarPorVerificacao(
      3,
      async (i) => i,
      async (c) => {
        verificados.push(c)
        return c === 1 // candidato 0 falha, 1 passa
      },
      async () => {},
    )
    expect(r.vencedor).toBe(1)
    expect(verificados).toEqual([0, 1]) // 2 nem foi verificado
    expect(r.verificados).toBe(2)
  })

  test("reverte cada candidato que falha antes de tentar o próximo", async () => {
    const revertidos: number[] = []
    const r = await selecionarPorVerificacao(
      3,
      async (i) => i,
      async (c) => c === 2,
      async (c) => {
        revertidos.push(c)
      },
    )
    expect(r.vencedor).toBe(2)
    expect(revertidos).toEqual([0, 1]) // o vencedor (2) não é revertido
  })

  test("nenhum verde -> vencedor null, todos verificados e revertidos", async () => {
    const revertidos: number[] = []
    const r = await selecionarPorVerificacao(
      3,
      async (i) => i,
      async () => false,
      async (c) => {
        revertidos.push(c)
      },
    )
    expect(r.vencedor).toBeNull()
    expect(r.verificados).toBe(3)
    expect(revertidos).toEqual([0, 1, 2])
  })

  test("candidatos nulos (geração inválida) são descartados", async () => {
    const r = await selecionarPorVerificacao(
      4,
      async (i) => (i % 2 === 0 ? i : null),
      async () => false,
      async () => {},
    )
    expect(r.gerados).toBe(2) // só 0 e 2
  })

  test("geração que lança é tolerada (vira candidato descartado)", async () => {
    const r = await selecionarPorVerificacao(
      2,
      async (i) => {
        if (i === 0) throw new Error("boom")
        return i
      },
      async () => true,
      async () => {},
    )
    expect(r.vencedor).toBe(1)
  })

  test("n<=0 é no-op", async () => {
    const r = await selecionarPorVerificacao(0, async () => 1, async () => true, async () => {})
    expect(r).toEqual({ vencedor: null, gerados: 0, verificados: 0 })
  })
})
