import { test, expect, describe, afterAll } from "bun:test"
import { rm } from "node:fs/promises"
import { ferramentas } from "./index"
import { ferramentasDaFase } from "../agent/planner"
import { resetCamada4 } from "../agent/camada4"

const DIR = "test-tmp-criar-arquivo"
const opts = {} as never // execute não usa options; satisfaz a assinatura do AI SDK

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true })
})

describe("criar_arquivo", () => {
  test("cria arquivo novo do zero (com subpasta) e escreve no disco", async () => {
    resetCamada4() // escopo livre
    const caminho = `${DIR}/novo.ts`
    const conteudo = "export const ola = () => console.log('olá')\n"
    const r = await ferramentas.criar_arquivo.execute!({ caminho, conteudo, motivo: "teste" }, opts)
    expect(String(r)).toContain("criado")
    expect(await Bun.file(caminho).exists()).toBe(true)
    expect(await Bun.file(caminho).text()).toBe(conteudo)
  })

  test("recusa se o arquivo já existe (sem reescrita cega)", async () => {
    resetCamada4()
    const caminho = `${DIR}/existe.ts`
    await ferramentas.criar_arquivo.execute!({ caminho, conteudo: "a\n", motivo: "1º" }, opts)
    const r = await ferramentas.criar_arquivo.execute!({ caminho, conteudo: "b\n", motivo: "2º" }, opts)
    expect(String(r)).toContain("já existe")
    expect(await Bun.file(caminho).text()).toBe("a\n") // conteúdo original preservado
  })

  test("bloqueia caminho fora do projeto", async () => {
    resetCamada4()
    const r = await ferramentas.criar_arquivo.execute!(
      { caminho: "../../../tmp/fora.ts", conteudo: "x", motivo: "teste" },
      opts,
    )
    expect(String(r)).toMatch(/fora do projeto|bloqueado/)
  })
})

describe("wiring — criar_arquivo exposto ao modelo na execução", () => {
  test("está no toolset", () => {
    expect(ferramentas.criar_arquivo).toBeDefined()
  })
  test("ferramentasDaFase inclui criar_arquivo na fase de editar", () => {
    expect(ferramentasDaFase("editar")).toContain("criar_arquivo")
    expect(ferramentasDaFase("geral")).toContain("criar_arquivo")
  })
})
