import { test, expect, describe, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseEnv, carregarConfigGlobal, salvarConfigGlobal, configurarChave } from "./env"

describe("config/env — parseEnv", () => {
  test("parseia KEY=VALUE; ignora comentário, linha vazia e linha sem '='", () => {
    expect(parseEnv("# comentário\n\nA=1\nB = dois \nLIXO\nC=")).toEqual({ A: "1", B: "dois", C: "" })
  })
  test("tira aspas simples e duplas do valor", () => {
    expect(parseEnv(`X="aspas"\nY='single'`)).toEqual({ X: "aspas", Y: "single" })
  })
  test("corta no primeiro '=' — valor com '=' interno fica inteiro", () => {
    expect(parseEnv("URL=http://x?a=b")).toEqual({ URL: "http://x?a=b" })
  })
})

describe("config/env — carregarConfigGlobal", () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
    delete process.env.__JADE_TEST_KEY
  })

  test("carrega a chave do arquivo pro process.env quando está ausente", () => {
    dir = mkdtempSync(join(tmpdir(), "jade-cfg-"))
    const arq = join(dir, ".env")
    writeFileSync(arq, "__JADE_TEST_KEY=do-arquivo")
    carregarConfigGlobal(arq)
    expect(process.env.__JADE_TEST_KEY).toBe("do-arquivo")
  })

  test("NÃO sobrescreve o que já está no process.env (shell/cwd vencem)", () => {
    dir = mkdtempSync(join(tmpdir(), "jade-cfg-"))
    const arq = join(dir, ".env")
    writeFileSync(arq, "__JADE_TEST_KEY=do-arquivo")
    process.env.__JADE_TEST_KEY = "do-shell"
    carregarConfigGlobal(arq)
    expect(process.env.__JADE_TEST_KEY).toBe("do-shell")
  })

  test("arquivo ausente é no-op (degrada, não crasha)", () => {
    expect(() => carregarConfigGlobal("/caminho/que/nao/existe/.env")).not.toThrow()
  })
})

describe("config/env — salvarConfigGlobal", () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
    delete process.env.OPENROUTER_API_KEY
  })

  test("grava a chave e relê via carregarConfigGlobal (round-trip)", () => {
    dir = mkdtempSync(join(tmpdir(), "jade-save-"))
    const arq = join(dir, ".env")
    salvarConfigGlobal("OPENROUTER_API_KEY", "sk-or-xyz", arq)
    delete process.env.OPENROUTER_API_KEY
    carregarConfigGlobal(arq)

    const relida = process.env.OPENROUTER_API_KEY as string | undefined
    expect(relida).toBe("sk-or-xyz")
  })

  test("preserva outras chaves já no arquivo", () => {
    dir = mkdtempSync(join(tmpdir(), "jade-save-"))
    const arq = join(dir, ".env")
    writeFileSync(arq, "OUTRA=mantida\n")
    salvarConfigGlobal("OPENROUTER_API_KEY", "sk-or-novo", arq)
    expect(parseEnv(readFileSync(arq, "utf8"))).toEqual({ OUTRA: "mantida", OPENROUTER_API_KEY: "sk-or-novo" })
  })

  test("cria o diretório se não existir", () => {
    dir = mkdtempSync(join(tmpdir(), "jade-save-"))
    const arq = join(dir, "sub/dir/.env")
    salvarConfigGlobal("K", "v", arq)
    expect(parseEnv(readFileSync(arq, "utf8"))).toEqual({ K: "v" })
  })
})

describe("config/env — configurarChave (fluxo bring-your-own-key)", () => {
  const novoUi = () => {
    const msgs: string[] = []
    return {
      msgs,
      ui: {
        aviso: (m: string) => msgs.push(`aviso:${m}`),
        subItem: (m: string) => msgs.push(`sub:${m}`),
        info: (m: string) => msgs.push(`info:${m}`),
        sucesso: (m: string) => msgs.push(`ok:${m}`),
      },
    }
  }

  test("sem TTY: instrui onde configurar e devolve null sem perguntar", async () => {
    const { msgs, ui } = novoUi()
    let perguntou = false
    const r = await configurarChave({ temTTY: false, perguntar: async () => ((perguntou = true), "x"), ui, salvar: () => {} })
    expect(r).toBeNull()
    expect(perguntou).toBe(false)
    expect(msgs.some((m) => m.includes("OPENROUTER_API_KEY"))).toBe(true)
  })

  test("TTY + chave válida na 1ª tentativa: salva e devolve a chave (trim)", async () => {
    const { ui } = novoUi()
    const salvas: [string, string][] = []
    const r = await configurarChave({ temTTY: true, perguntar: async () => "  sk-or-abc  ", ui, salvar: (c, v) => salvas.push([c, v]) })
    expect(r).toBe("sk-or-abc")
    expect(salvas).toEqual([["OPENROUTER_API_KEY", "sk-or-abc"]])
  })

  test("TTY: rejeita formato inválido e aceita a próxima válida", async () => {
    const { ui } = novoUi()
    const respostas = ["lixo", "sk-or-ok"]
    let i = 0
    const r = await configurarChave({ temTTY: true, perguntar: async () => respostas[i++] ?? null, ui, salvar: () => {} })
    expect(r).toBe("sk-or-ok")
  })

  test("TTY + EOF (Ctrl+D): devolve null sem salvar", async () => {
    const { ui } = novoUi()
    let salvou = false
    const r = await configurarChave({ temTTY: true, perguntar: async () => null, ui, salvar: () => ((salvou = true), undefined) })
    expect(r).toBeNull()
    expect(salvou).toBe(false)
  })

  test("TTY + 3 tentativas inválidas: desiste e devolve null", async () => {
    const { ui } = novoUi()
    let chamadas = 0
    const r = await configurarChave({ temTTY: true, perguntar: async () => ((chamadas++), "nope"), ui, salvar: () => {} })
    expect(r).toBeNull()
    expect(chamadas).toBe(3)
  })
})
