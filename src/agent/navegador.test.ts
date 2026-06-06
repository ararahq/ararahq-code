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

  test("CAUSA com preâmbulo e bold markdown ainda conta como cravou (não exige começar com CAUSA:)", () => {
    const texto = "Já identifiquei a causa. Vou sintetizar.\n\n**CAUSA:** src/infra/Mutex.kt:23-36 — lock distribuído não atômico (get+set separados, TOCTOU)."
    expect(ehCravado(texto)).toBe(true)
  })

  test("preâmbulo seguido de CAUSA com hedge não conta como cravou", () => {
    const texto = "Investiguei um pouco.\n\nCAUSA: talvez seja no Mutex, mas não tenho certeza do ponto exato."
    expect(ehCravado(texto)).toBe(false)
  })
})
