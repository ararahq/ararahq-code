import { test, expect, describe } from "bun:test"
import {
  rotear,
  proximoModeloEscalada,
  subirEsforco,
  proximoFallbackDiagnostico,
  deveReclassificarPraDiagnostico,
  MODELOS,
  CADEIA_DIAGNOSTICO,
  PERFIS,
  PERFIL_PADRAO,
  perfilAtivo,
  CUSTO,
} from "./router"

describe("3.6 — rotear com tarefa composta", () => {
  test("diag+exec com arquivo citado força DIAGNÓSTICO (não pula pra execução)", () => {

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

describe("perfis de roteamento (JADE_PERFIL)", () => {
  test("perfilAtivo cai no padrão sem env ou com valor inválido", () => {
    expect(perfilAtivo({})).toBe(PERFIL_PADRAO)
    expect(perfilAtivo({ JADE_PERFIL: "nao-existe" })).toBe(PERFIL_PADRAO)
  })

  test("perfilAtivo reconhece uncensored (case/space-insensitive)", () => {
    expect(perfilAtivo({ JADE_PERFIL: "uncensored" })).toBe("uncensored")
    expect(perfilAtivo({ JADE_PERFIL: "  UNCENSORED  " })).toBe("uncensored")
  })

  test("todo perfil declara as 4 marchas + cauda não-vazia", () => {
    for (const [nome, p] of Object.entries(PERFIS)) {
      for (const chave of ["execucao", "diagnostico", "loopLongo", "compreender"] as const) {
        expect(p[chave], `${nome}.${chave}`).toBeTruthy()
      }
      expect(p.cauda.length, `${nome}.cauda`).toBeGreaterThan(0)
    }
  })

  test("CUSTO cobre todo slug dos perfis pagos (local é grátis, não entra)", () => {
    for (const [nome, p] of Object.entries(PERFIS)) {
      if (p.provedor !== "openrouter") continue
      for (const slug of [p.execucao, p.diagnostico, p.loopLongo, p.compreender, ...p.cauda]) {
        expect(CUSTO[slug], `custo faltando pra ${nome}: ${slug}`).toBeDefined()
      }
    }
  })

  test("perfil local usa provedor ollama; perfis pagos usam openrouter", () => {
    expect(PERFIS.local.provedor).toBe("ollama")
    expect(PERFIS.padrao.provedor).toBe("openrouter")
    expect(PERFIS.uncensored.provedor).toBe("openrouter")
  })

  test("MODELOS espelha o perfil default no boot (sem JADE_PERFIL no ambiente de teste)", () => {
    expect(MODELOS.execucao).toBe(PERFIS[PERFIL_PADRAO].execucao)
    expect(MODELOS.diagnostico).toBe(PERFIS[PERFIL_PADRAO].diagnostico)
  })
})

// Invariante crítico: o Jade é agêntico, então TODO modelo de TODO perfil precisa expor
// tool-calling no OpenRouter — senão o agente morre com "No endpoints found that support
// tool use". Bate na API real, então roda só com JADE_TEST_LIVE=1 (fora da suíte offline).
describe("invariante de tool-calling (live — JADE_TEST_LIVE=1)", () => {
  test.skipIf(!process.env.JADE_TEST_LIVE)("todo slug de todo perfil suporta `tools`", async () => {
    const resp = await fetch("https://openrouter.ai/api/v1/models")
    const { data } = (await resp.json()) as { data: { id: string; supported_parameters?: string[] }[] }
    const comTools = new Set(data.filter((m) => (m.supported_parameters ?? []).includes("tools")).map((m) => m.id))
    for (const [nome, p] of Object.entries(PERFIS)) {
      if (p.provedor !== "openrouter") continue // local é checado contra o Ollama, não a API
      for (const slug of [p.execucao, p.diagnostico, p.loopLongo, p.compreender, ...p.cauda]) {
        expect(comTools.has(slug), `${nome}: ${slug} não expõe tool-calling no OpenRouter`).toBe(true)
      }
    }
  })
})
