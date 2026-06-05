import { test, expect, describe } from "bun:test"
import {
  rotear,
  proximoModeloEscalada,
  subirEsforco,
  proximoFallbackDiagnostico,
  deveReclassificarPraDiagnostico,
  MODELOS,
  CADEIA_DIAGNOSTICO,
} from "./router"

describe("3.6 — rotear com tarefa composta", () => {
  test("diag+exec com arquivo citado força DIAGNÓSTICO (não pula pra execução)", () => {
    // O bug que 3.6 mata: o desempate por arquivo citado mandaria pra execução, pulando o diagnóstico.
    const d = rotear("diagnostica o bug no PoolService.kt e corrige")
    expect(d.modo).toBe("diagnostico")
    expect(d.pedirQuebra).toBeUndefined()
  })

  test("3+ intenções -> pedirQuebra", () => {
    const d = rotear("investiga o bug, corrige o service e refatora o controller")
    expect(d.pedirQuebra).toBe(true)
  })

  test("execução pura preservada (sem composta)", () => {
    expect(rotear("troca a linha 10 do main.cpp").modo).toBe("execucao")
  })

  test("conversa preservada", () => {
    expect(rotear("oi tudo bem").modo).toBe("conversa")
  })

  test("compreender roteia pro modelo de contexto longo barato, thinking off", () => {
    const d = rotear("me explica como funciona o fluxo de login")
    expect(d.modo).toBe("compreender")
    expect(d.modelo).toBe(MODELOS.compreender)
    expect(d.thinking).toBe(false)
  })

  test("planejar reusa M3 (raciocínio) com thinking on, sem executar", () => {
    const d = rotear("monta um plano pra migrar o billing pro novo provider")
    expect(d.modo).toBe("planejar")
    expect(d.modelo).toBe(MODELOS.diagnostico)
    expect(d.thinking).toBe(true)
  })

  test("comunicar reusa M2 (barato), thinking off", () => {
    const d = rotear("escreve o commit dessa mudança")
    expect(d.modo).toBe("comunicar")
    expect(d.modelo).toBe(MODELOS.execucao)
    expect(d.thinking).toBe(false)
  })

  test("stack trace -> diagnóstico forte", () => {
    const d = rotear('Exception at com.foo.Bar(Bar.kt:42)')
    expect(d.modo).toBe("diagnostico")
    expect(d.modelo).toBe(MODELOS.diagnostico)
  })
})

describe("escalada e fallback (puras, regressão)", () => {
  test("proximoModeloEscalada sobe execucao -> loopLongo -> topo", () => {
    expect(proximoModeloEscalada({ modeloAtual: MODELOS.execucao })).toBe(MODELOS.loopLongo)
    expect(proximoModeloEscalada({ modeloAtual: MODELOS.loopLongo })).toBeNull()
  })

  test("subirEsforco: thinking antes de trocar de modelo", () => {
    expect(subirEsforco({ modelo: MODELOS.execucao, thinking: false })).toEqual({ modelo: MODELOS.execucao, thinking: true })
    expect(subirEsforco({ modelo: MODELOS.execucao, thinking: true })).toEqual({ modelo: MODELOS.loopLongo, thinking: true })
    expect(subirEsforco({ modelo: MODELOS.loopLongo, thinking: true })).toBeNull()
  })

  test("proximoFallbackDiagnostico anda na cadeia", () => {
    expect(proximoFallbackDiagnostico(CADEIA_DIAGNOSTICO[0])).toBe(CADEIA_DIAGNOSTICO[1])
    expect(proximoFallbackDiagnostico(CADEIA_DIAGNOSTICO[CADEIA_DIAGNOSTICO.length - 1])).toBeNull()
    expect(proximoFallbackDiagnostico("modelo-desconhecido")).toBeNull()
  })

  test("deveReclassificarPraDiagnostico só quando execução sem edição e resposta hedge", () => {
    expect(deveReclassificarPraDiagnostico("execucao", false, "não tenho certeza, talvez seja no service")).toBe(true)
    expect(deveReclassificarPraDiagnostico("execucao", true, "não tenho certeza")).toBe(false)
    expect(deveReclassificarPraDiagnostico("diagnostico", false, "talvez")).toBe(false)
  })
})
