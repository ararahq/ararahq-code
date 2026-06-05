import { test, expect, describe, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gerarResumos, carregarResumos, type AlvoResumo } from "./resumos"

const homeOriginal = process.env.HOME
let tmp: string | null = null

afterEach(async () => {
  process.env.HOME = homeOriginal
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = null
})

async function comHomeTemp(): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), "arara-res-"))
  process.env.HOME = tmp
  return "/proj/x"
}

const alvos: AlvoResumo[] = [
  { arquivo: "a.ts", hash: "h1", conteudo: "export const a = 1" },
  { arquivo: "b.ts", hash: "h1", conteudo: "export const b = 2" },
]

describe("1.4 — gerarResumos", () => {
  test("gera, cacheia e usa o resultado da ResumirFn (1 chamada por arquivo)", async () => {
    const raiz = await comHomeTemp()
    let chamadas = 0
    const fn = async (arquivo: string) => {
      chamadas++
      return `resumo de ${arquivo}`
    }
    const cache = await gerarResumos(raiz, alvos, fn)
    expect(chamadas).toBe(2)
    expect(cache["a.ts"]?.resumo).toBe("resumo de a.ts")
    expect((await carregarResumos(raiz))["b.ts"]?.resumo).toBe("resumo de b.ts")
  })

  test("hash inalterado não regenera (cache hit, zero chamada)", async () => {
    const raiz = await comHomeTemp()
    let chamadas = 0
    const fn = async () => {
      chamadas++
      return "x"
    }
    await gerarResumos(raiz, alvos, fn)
    chamadas = 0
    await gerarResumos(raiz, alvos, fn)
    expect(chamadas).toBe(0)
  })

  test("hash mudou regenera só o arquivo alterado", async () => {
    const raiz = await comHomeTemp()
    let chamadas = 0
    const fn = async (arquivo: string) => {
      chamadas++
      return `novo ${arquivo}`
    }
    await gerarResumos(raiz, alvos, fn)
    chamadas = 0
    await gerarResumos(raiz, [{ arquivo: "a.ts", hash: "h2", conteudo: "mudou" }, alvos[1]], fn)
    expect(chamadas).toBe(1)
  })

  test("sem ResumirFn (null) é no-op e devolve o cache atual", async () => {
    const raiz = await comHomeTemp()
    const cache = await gerarResumos(raiz, alvos, null)
    expect(cache).toEqual({})
  })
})
