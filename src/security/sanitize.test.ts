import { test, expect, describe } from "bun:test"
import { sanitizar, pathSeguro } from "./sanitize"

describe("sanitizar — redação de secrets na saída", () => {
  test("redige api key, AWS key e JWT", () => {
    const r = sanitizar(
      'API_KEY=sk_live_abcdef1234567890abcd token AKIAIOSFODNN7EXAMPLE jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123',
    )
    expect(r).not.toContain("sk_live_")
    expect(r).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(r).not.toContain("eyJhbGciOiJIUzI1NiJ9")
    expect(r).toContain("[REDACTED]")
  })

  test("redige senha e connection string", () => {
    const r = sanitizar("senha=SuperSecreta1 e postgres://user:pass@db.interno:5432/app")
    expect(r).not.toContain("SuperSecreta1")
    expect(r).not.toContain("user:pass@db.interno")
  })

  test("não toca em texto normal", () => {
    const t = "o roteamento é determinístico e escolhe a marcha certa"
    expect(sanitizar(t)).toBe(t)
  })
})

describe("pathSeguro — leitura/edição presa à raiz do projeto", () => {
  test("aceita caminho dentro da raiz", () => {
    expect(pathSeguro("src/index.ts")).toContain("/src/index.ts")
  })

  test("bloqueia escape da raiz e arquivos de segredo", () => {
    expect(pathSeguro("../fora-do-projeto.ts")).toBeNull()
    expect(pathSeguro(".env")).toBeNull()
    expect(pathSeguro("config/.env.local")).toBeNull()
    expect(pathSeguro("certs/chave.pem")).toBeNull()
    expect(pathSeguro("secrets.yaml")).toBeNull()
  })
})
