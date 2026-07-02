import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { queryDe, parseHits, renderMapa, detectouHedge, parseFalta, montarPares, renderPares } from "./diagnostico"

describe("queryDe", () => {
  test("com 2+ termos específicos, descarta os genéricos da alternância", () => {
    expect(queryDe(["shared", "dedicated", "number"])).toBe("shared|dedicated")
  })

  test("só genéricos: usa todos (não devolve query vazia)", () => {
    expect(queryDe(["number", "message"])).toBe("number|message")
  })

  test("escapa metacaracteres de regex", () => {
    expect(queryDe(["a.b", "c(d", "x+y"])).toBe("a\\.b|c\\(d|x\\+y")
  })

  test("vazio pra lista vazia", () => {
    expect(queryDe([])).toBe("")
  })
})

describe("parseHits", () => {
  test("converte saída do grep em hits estruturados, sem ./ inicial", () => {
    const hits = parseHits("./src/a.ts:12:const x = 1\nsrc/b.kt:96:  val y = 2\n")
    expect(hits).toEqual([
      { arquivo: "src/a.ts", linha: 12, trecho: "const x = 1" },
      { arquivo: "src/b.kt", linha: 96, trecho: "val y = 2" },
    ])
  })

  test("trunca trecho longo e respeita o teto de hits", () => {
    const longo = "x".repeat(300)
    const linhas = Array.from({ length: 30 }, (_, i) => `a.ts:${i + 1}:${longo}`).join("\n")
    const hits = parseHits(linhas)
    expect(hits.length).toBeLessThanOrEqual(15)
    expect(hits[0].trecho.endsWith("…")).toBe(true)
    expect(hits[0].trecho.length).toBeLessThanOrEqual(161)
  })

  test("ignora linha que não é hit", () => {
    expect(parseHits("linha solta sem formato\n")).toEqual([])
  })
})

describe("renderMapa", () => {
  test("vazio sem hits; com hits lista arquivo:linha", () => {
    expect(renderMapa(["ledger"], [])).toBe("")
    const mapa = renderMapa(["ledger"], [{ arquivo: "src/a.ts", linha: 12, trecho: "x" }])
    expect(mapa).toContain("PONTOS QUE TOCAM EM ledger")
    expect(mapa).toContain("src/a.ts:12")
  })
})

describe("detectouHedge — o gate que decide escalar de modelo", () => {
  test("FALTA: pedindo arquivo = não cravou", () => {
    expect(detectouHedge("FALTA: src/servico.ts")).toBe(true)
  })

  test("sem nenhum ponto concreto = não cravou", () => {
    expect(detectouHedge("provavelmente é algo no serviço de pagamento, verifique a configuração")).toBe(true)
  })

  test("arquivo:linha concreto = cravou", () => {
    expect(detectouHedge("CAUSA RAIZ — src/billing/LedgerService.kt:96: usa findFirst sem filtro")).toBe(false)
  })

  test("'linha N' também conta como ponto concreto", () => {
    expect(detectouHedge("a causa está na linha 42 do serviço")).toBe(false)
  })

  test("ressalva de implementação na CORREÇÃO não vira hedge quando há arquivo:linha", () => {
    expect(detectouHedge("CAUSA RAIZ — src/a.ts:10. CORREÇÃO: se o método não existir, adicione.")).toBe(false)
  })
})

describe("parseFalta", () => {
  test("extrai os arquivos pedidos, sem ./ e só com extensão de código", () => {
    expect(parseFalta("análise...\nFALTA: ./src/a.ts, src/b.kt")).toEqual(["src/a.ts", "src/b.kt"])
  })

  test("descarta token sem extensão e limita a 4", () => {
    const r = parseFalta("FALTA: semext, a.ts b.ts c.ts d.ts e.ts")
    expect(r).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"])
  })

  test("vazio quando não pediu nada", () => {
    expect(parseFalta("CAUSA RAIZ — src/a.ts:10")).toEqual([])
  })
})

describe("montarPares", () => {
  const dir = mkdtempSync(join(tmpdir(), "jade-diag-"))
  const servico = join(dir, "LedgerService.kt")
  writeFileSync(
    servico,
    [
      "class LedgerService(private val repo: LedgerRepo) {",
      "  fun creditLedger(org: String) {",
      "    val conta = repo.findFirstByOrgIdAndActiveTrue(org)",
      "    conta.credit()",
      "  }",
      "  fun debitLedger(org: String) {",
      "    val conta = repo.findFirstByOrgId(org)",
      "    conta.debit()",
      "  }",
      "}",
    ].join("\n"),
  )

  test("pareia métodos irmãos que chamam a mesma família com alvo divergente", async () => {
    const pares = await montarPares(["ledger"], [{ arquivo: servico, hits: 3 }])
    expect(pares.length).toBeGreaterThanOrEqual(1)
    const p = pares[0]
    expect(p.familia).toBe("findFirst")
    expect(p.a.metodo).not.toBe(p.b.metodo)
    expect([p.a.metodo, p.b.metodo].sort()).toEqual(["creditLedger", "debitLedger"])
  })

  test("arquivo com poucos hits não entra no pareamento", async () => {
    const pares = await montarPares(["ledger"], [{ arquivo: servico, hits: 1 }])
    expect(pares).toEqual([])
  })

  test("arquivo inexistente degrada pra vazio sem crashar", async () => {
    const pares = await montarPares(["ledger"], [{ arquivo: join(dir, "nao-existe.kt"), hits: 5 }])
    expect(pares).toEqual([])
  })

  test("renderPares monta a pergunta fechada A vs B", async () => {
    const pares = await montarPares(["ledger"], [{ arquivo: servico, hits: 3 }])
    const texto = renderPares(pares, ["ledger"])
    expect(texto).toContain("PAR 1")
    expect(texto).toContain("[A]")
    expect(texto).toContain("[B]")
    expect(texto).toContain("PERGUNTA")
  })
})
