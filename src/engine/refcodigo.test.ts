import { test, expect, describe } from "bun:test"
import {
  pareceReferenciaCodigo,
  extrairArquivosCitados,
  refsNoIndice,
  type IndiceParaRef,
} from "./refcodigo"

describe("pareceReferenciaCodigo — extensões agnósticas (sem lista chumbada)", () => {

  test.each([
    "olha o main.cpp",
    "roda o deploy.sh",
    "o helper.rb tá errado",
    "AppDelegate.swift quebrou",
    "confere o Dockerfile.dev e o config.dockerfile",
    "o arquivo build.gradle.kts",
    "a query em repo.go",
  ])("detecta código em %p", (input) => {
    expect(pareceReferenciaCodigo(input)).toBe(true)
  })

  test("não confunde número de versão com arquivo", () => {
    expect(pareceReferenciaCodigo("a versão é 3.14 e o pi vale 1.5")).toBe(false)
  })

  test("prosa pura não é código", () => {
    expect(pareceReferenciaCodigo("oi tudo bem como você está hoje")).toBe(false)
    expect(pareceReferenciaCodigo("os números salvam errado de vez em quando")).toBe(false)
  })
})

describe("pareceReferenciaCodigo — caminhos e identificadores", () => {
  test("caminho com barra", () => {
    expect(pareceReferenciaCodigo("mexe em src/agent/router")).toBe(true)
  })
  test("camelCase e PascalCase com 2+ palavras", () => {
    expect(pareceReferenciaCodigo("o isShared volta null")).toBe(true)
    expect(pareceReferenciaCodigo("no LedgerService")).toBe(true)
  })
  test("palavra única capitalizada NÃO é código (prosa/tecnologia solta)", () => {
    expect(pareceReferenciaCodigo("gosto de Java")).toBe(false)
    expect(pareceReferenciaCodigo("uso Python no dia a dia")).toBe(false)
  })
  test("chamada de função colada no parêntese", () => {
    expect(pareceReferenciaCodigo("a salvar() não persiste")).toBe(true)
    expect(pareceReferenciaCodigo("vou ali (já volto)")).toBe(false)
  })
  test("exceção nomeada", () => {
    expect(pareceReferenciaCodigo("estoura LinkNotFoundException")).toBe(true)
  })
})

describe("refsNoIndice — index-first", () => {
  const indice: IndiceParaRef = {
    simbolos: [{ arquivo: "src/agent/router.ts" }, { arquivo: "lib/pool.go" }],
    reverso: { LedgerService: ["a.kt"], pool: ["lib/pool.go"] },
  }

  test("confirma token que é arquivo real do índice (por base name)", () => {
    expect(refsNoIndice("dá uma olhada no router.ts", indice)).toContain("router.ts")
  })
  test("confirma token que é símbolo real do índice", () => {
    expect(refsNoIndice("o pool tá vazando", indice)).toContain("pool")
  })
  test("token que não existe no índice não é confirmado", () => {
    expect(refsNoIndice("o widget sumiu", indice)).toEqual([])
  })
  test("index-first cobre referência que o padrão sozinho perderia", () => {

    expect(pareceReferenciaCodigo("o pool falha", undefined)).toBe(false)
    expect(pareceReferenciaCodigo("o pool falha", indice)).toBe(true)
  })
})

describe("extrairArquivosCitados", () => {
  test("extrai múltiplos, normaliza ./ e dedupe", () => {
    const r = extrairArquivosCitados("edita ./src/a.ts e src/a.ts, depois deploy.sh e main.cpp")
    expect(r).toEqual(["src/a.ts", "deploy.sh", "main.cpp"])
  })
  test("ignora versão e prosa", () => {
    expect(extrairArquivosCitados("a v3.14 não é arquivo, mas pool.go é")).toEqual(["pool.go"])
  })
})
