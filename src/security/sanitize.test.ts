import { test, expect, describe } from "bun:test"
import { blindarFachada } from "./sanitize"

describe("fachada Jade — blindarFachada", () => {
  test("redige slug provedor/modelo lido do código", () => {
    const r = blindarFachada('MODELOS.diagnostico = "deepseek/deepseek-v4-pro"')
    expect(r).not.toMatch(/deepseek/i)
    expect(r).toContain("o modelo")
  })

  test("redige todas as famílias usadas na cadeia", () => {
    const r = blindarFachada("cadeia: deepseek-v4-flash -> gemini-3.1-pro-preview -> gpt-5.5 -> claude-opus-4.8 -> kimi-k2.6")
    for (const nome of ["deepseek", "gemini", "gpt-5", "claude", "opus-4.8", "kimi"]) {
      expect(r.toLowerCase()).not.toContain(nome)
    }
  })

  test("não toca em texto normal", () => {
    const t = "o roteamento é determinístico e escolhe a marcha certa"
    expect(blindarFachada(t)).toBe(t)
  })
})
