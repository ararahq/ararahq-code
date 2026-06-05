import { test, expect, describe } from "bun:test"
import { ehCravado } from "./navegador"

describe("navegador — ehCravado (commit estruturado)", () => {
  test("CAUSA: com arquivo:linha + explicação = cravou", () => {
    expect(ehCravado("CAUSA: src/auth/auth.ts:42 — aceita senha vazia porque não valida o campo")).toBe(true)
  })

  test("NÃO CRAVEI: = abstenção, não cravou (mesmo apontando arquivos)", () => {
    expect(ehCravado("NÃO CRAVEI: prováveis: src/auth.ts, src/login.ts — não consegui confirmar")).toBe(false)
  })

  test("texto vazio = não cravou (loop estourou sem concluir)", () => {
    expect(ehCravado("")).toBe(false)
  })

  test("prosa sem o prefixo CAUSA = não cravou", () => {
    expect(ehCravado("Acho que o problema está no arquivo de autenticação em algum lugar")).toBe(false)
  })

  test("CAUSA com hedge (sem ponto concreto) não conta como cravou", () => {
    expect(ehCravado("CAUSA: talvez seja algo relacionado a autenticação, não tenho certeza")).toBe(false)
  })
})
