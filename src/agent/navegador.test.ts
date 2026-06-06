import { test, expect, describe } from "bun:test"
import type { Indice, Simbolo } from "../conhecimento"
import { ehCravado, extrairArquivoConcluido, resolverArquivo, corroborarConclusao } from "./navegador"

/** Índice fake mínimo pra corroboração (arquivo + símbolos com nome/chama). */
function fakeIndice(arquivos: { arquivo: string; simbolos: Partial<Simbolo>[] }[]): Indice {
  return {
    simbolos: arquivos.map((a) => ({
      arquivo: a.arquivo,
      simbolos: a.simbolos.map((s) => ({
        nome: "", tipo: "funcao", arquivo: a.arquivo, linhaInicio: 1, linhaFim: 2,
        assinatura: "", herda: [], chama: [], usaTipo: [], ...s,
      })),
    })),
  } as unknown as Indice
}

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

describe("navegador — extrairArquivoConcluido", () => {
  test("pega o path da linha CAUSA (com :linha, com bold/preâmbulo)", () => {
    expect(extrairArquivoConcluido("CAUSA: src/infra/Mutex.kt:23 — TOCTOU")).toBe("src/infra/Mutex.kt")
    expect(extrairArquivoConcluido("Preâmbulo.\n\n**CAUSA:** a/b/Foo.ts:10-20 — x")).toBe("a/b/Foo.ts")
  })
  test("null quando não há linha CAUSA", () => {
    expect(extrairArquivoConcluido("NÃO CRAVEI: prováveis a.ts, b.ts")).toBeNull()
  })
})

describe("navegador — corroborarConclusao (abstenção honesta + variância estrutural)", () => {
  const indice = fakeIndice([
    { arquivo: "src/Mutex.kt", simbolos: [{ nome: "Mutex" }] },
    { arquivo: "src/Caller.kt", simbolos: [{ nome: "Caller", chama: ["Mutex"] }] },
    { arquivo: "src/Unrelated.kt", simbolos: [{ nome: "Unrelated" }] },
  ])

  test("ancorado quando a causa é o próprio candidato", () => {
    expect(corroborarConclusao(indice, "CAUSA: src/Mutex.kt:1 — x", ["src/Mutex.kt"]).grounded).toBe(true)
  })

  test("ancorado quando alcançável pelo call-graph (candidato chama a causa)", () => {
    // Caller chama Mutex → conclusão em Mutex.kt é alcançável a partir do candidato Caller.kt.
    expect(corroborarConclusao(indice, "CAUSA: src/Mutex.kt:1 — x", ["src/Caller.kt"]).grounded).toBe(true)
  })

  test("REBAIXA quando desconectado do sintoma (não-candidato, não-alcançável)", () => {
    const cor = corroborarConclusao(indice, "CAUSA: src/Unrelated.kt:1 — x", ["src/Mutex.kt"])
    expect(cor.grounded).toBe(false)
    expect(cor.arquivo).toBe("src/Unrelated.kt")
  })

  test("REBAIXA quando cita arquivo inexistente (alucinação)", () => {
    const cor = corroborarConclusao(indice, "CAUSA: src/Fantasma.kt:1 — x", ["src/Mutex.kt"])
    expect(cor.grounded).toBe(false)
    expect(cor.motivo).toContain("não existe")
  })

  test("leniente: sem candidatos não rebaixa (não pune locator vazio)", () => {
    expect(corroborarConclusao(indice, "CAUSA: src/Mutex.kt:1 — x", []).grounded).toBe(true)
  })

  test("REBAIXA quando a conclusão não tem arquivo", () => {
    expect(corroborarConclusao(indice, "CAUSA: o problema é de concorrência", ["src/Mutex.kt"]).grounded).toBe(false)
  })
})
