import { test, expect, describe, beforeEach } from "bun:test"
import {
  resetRecovery,
  podeTrocarMarcha,
  registrarTrocaMarcha,
  trocasMarcha,
  registrarFalha,
  classificarOrigem,
  TETO_TROCAS_MARCHA,
} from "./recovery"

beforeEach(() => resetRecovery())

describe("3.5 — teto de trocas de marcha", () => {
  test("pode trocar até o teto; na 3ª troca esgota", () => {
    expect(podeTrocarMarcha()).toBe(true)
    registrarTrocaMarcha()
    registrarTrocaMarcha()
    expect(podeTrocarMarcha()).toBe(true)
    const r = registrarTrocaMarcha()
    expect(r.trocas).toBe(TETO_TROCAS_MARCHA)
    expect(r.podeContinuar).toBe(false)
    expect(podeTrocarMarcha()).toBe(false)
  })

  test("o teto global de tentativas (6) corta a troca mesmo sem ter trocado", () => {
    for (let i = 0; i < 6; i++) registrarFalha("error: type mismatch on line 10")
    expect(trocasMarcha()).toBe(0)
    expect(podeTrocarMarcha()).toBe(false)
  })

  test("resetRecovery zera as trocas", () => {
    registrarTrocaMarcha()
    resetRecovery()
    expect(trocasMarcha()).toBe(0)
    expect(podeTrocarMarcha()).toBe(true)
  })
})

describe("recovery — regressão", () => {
  test("classifica origem código vs ambiente", () => {
    expect(classificarOrigem("error: type mismatch")).toBe("codigo")
    expect(classificarOrigem("command not found: gradle")).toBe("ambiente")
  })
  test("3 erros de código no mesmo ponto disparam escalada", () => {
    registrarFalha("error TS2322 on line 5")
    registrarFalha("error TS2322 on line 5")
    const r = registrarFalha("error TS2322 on line 5")
    expect(r.escalar).toBe(true)
  })
})
