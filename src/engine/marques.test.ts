import { test, expect, describe } from "bun:test"
import {
  decidirModo,
  detectarComposta,
  detectarContradicao,
  tamanhoPrevisto,
  ehConversa,
  perfilTermos,
  resumoExtrativo,
  expandirDominio,
  pontuarDiff,
} from "./marques"

describe("copiloto — decidirModo planejar / comunicar", () => {
  test("pedido de plano vira planejar", () => {
    expect(decidirModo("monta um plano pra migrar o billing pro novo provider")).toBe("planejar")
    expect(decidirModo("como eu faria a refatoração do módulo de auth")).toBe("planejar")
  })
  test("pedido de commit/PR/changelog vira comunicar", () => {
    expect(decidirModo("escreve o commit dessa mudança")).toBe("comunicar")
    expect(decidirModo("faz o PR com a descrição do que mudou")).toBe("comunicar")
    expect(decidirModo("gera o changelog da release")).toBe("comunicar")
  })
  test("comunicar/planejar ganham do verbo de ação", () => {

    expect(decidirModo("escreve o commit e cria a tag")).toBe("comunicar")
  })
})

describe("COMUNICAR — pontuarDiff", () => {
  const diff = [
    "diff --git a/wallet.kt b/wallet.kt",
    "--- a/wallet.kt",
    "+++ b/wallet.kt",
    "+fun addCredit(amount: BigDecimal) { balance += amount; ledger.record(amount) }",
    "+fun refund(tx: Transaction) { balance += tx.cost }",
    "diff --git a/style.css b/style.css",
    "--- a/style.css",
    "+++ b/style.css",
    "+  margin: 0;",
  ].join("\n")

  test("ranqueia a mudança central acima da cosmética", () => {
    const r = pontuarDiff(diff)
    expect(r[0].arquivo).toBe("wallet.kt")
    expect(r[0].score).toBeGreaterThan(r[1].score)
  })
  test("conta adições por arquivo", () => {
    const r = pontuarDiff(diff)
    const wallet = r.find((m) => m.arquivo === "wallet.kt")
    expect(wallet?.adicoes).toBe(2)
  })
})

describe("Marques extrativo — perfilTermos / resumoExtrativo", () => {
  test("conta frequência e quebra camelCase + snake_case", () => {
    const p = perfilTermos("addCredit addCredit wallet_balance")
    expect(p.get("credit")).toBe(2)
    expect(p.get("add")).toBe(2)
    expect(p.get("wallet")).toBe(1)
    expect(p.get("balance")).toBe(1)
  })
  test("resumoExtrativo devolve os termos mais salientes primeiro", () => {
    const r = resumoExtrativo("pagamento pagamento pagamento estorno refund refund", 2)
    expect(r[0]).toBe("pagamento")
    expect(r).toContain("refund")
    expect(r.length).toBe(2)
  })
})

describe("Marques — ponte de domínio PT→EN (aterrada no vocab)", () => {
  test("expande por prefixo (recarga/saldo/dobrado -> credit/balance/double)", () => {
    const r = expandirDominio(["recarreguei", "saldo", "dobrado"])
    expect(r).toContain("credit")
    expect(r).toContain("balance")
    expect(r).toContain("double")
  })
  test("vocab aterra: só mantém alvos que existem no projeto", () => {
    const r = expandirDominio(["recarreguei"], new Set(["credit"]))
    expect(r).toContain("credit")
    expect(r).not.toContain("recharge")
    expect(r).not.toContain("topup")
  })
  test("preserva os tokens originais", () => {
    expect(expandirDominio(["saldo"])).toContain("saldo")
  })

  test("mapeia conta/cliente pro vocabulário de conta do projeto (achar o WalletService)", () => {
    const vocab = new Set(["organization", "user", "wallet", "balance", "credit"])
    const r = expandirDominio(["conta", "cliente", "credito"], vocab)
    expect(r).toContain("organization")
    expect(r).toContain("user")
    expect(r).toContain("credit")
  })
})

describe("3.7 — decidirModo usa referência agnóstica no desempate", () => {
  test("diag+exec com arquivo de extensão FORA da lista antiga (.sh) -> execução", () => {
    expect(decidirModo("investiga e troca isso no deploy.sh")).toBe("execucao")
  })
  test("diag+exec sem referência de código -> diagnóstico", () => {
    expect(decidirModo("investiga e troca isso")).toBe("diagnostico")
  })
  test("ehConversa: referência a código (.rb) não é conversa", () => {
    expect(ehConversa("oi, dá uma olhada no helper.rb")).toBe(false)
  })
})

describe("3.7 — tamanhoPrevisto conta arquivos de forma agnóstica", () => {
  test("4 arquivos de extensões fora da lista antiga -> grande", () => {
    expect(tamanhoPrevisto("mexe em a.cpp, b.sh, c.rb e d.swift")).toBe("grande")
  })
})

describe("copiloto — decidirModo compreender", () => {
  test("pedido de explicação/panorama vira compreender", () => {
    expect(decidirModo("me explica o fluxo de auth desse repo")).toBe("compreender")
    expect(decidirModo("o que faz o PoolService")).toBe("compreender")
    expect(decidirModo("me dá uma visão geral do projeto")).toBe("compreender")
  })
  test("explicar + pedir mudança NÃO é compreender (o verbo de ação puxa pra execução/diag)", () => {

    expect(decidirModo("explica o fluxo e troca a linha 10")).not.toBe("compreender")
  })
  test("conversa continua conversa", () => {
    expect(decidirModo("oi tudo bem")).toBe("conversa")
  })
})

describe("3.6 — detectarComposta", () => {
  test("diagnóstico + correção ligados por conector -> encadeada (M3 -> M5)", () => {
    const r = detectarComposta("diagnostica o problema de concorrência e cria a correção")
    expect(r).toEqual({ tipo: "encadeada", intencoes: ["diagnostico", "execucao"] })
  })

  test("ordem fixa: diagnóstico sempre antes da execução", () => {
    const r = detectarComposta("cria a correção depois que você investiga a causa")
    expect(r?.tipo).toBe("encadeada")
    if (r?.tipo === "encadeada") expect(r.intencoes).toEqual(["diagnostico", "execucao"])
  })

  test("3+ intenções com verbo -> demais (pedir pra quebrar)", () => {
    const r = detectarComposta("investiga o bug, corrige o service e refatora o controller")
    expect(r).toEqual({ tipo: "demais" })
  })

  test("intenção única (só diagnóstico) -> null", () => {
    expect(detectarComposta("por que o número salva errado")).toBeNull()
  })

  test("intenção única (só execução) -> null", () => {
    expect(detectarComposta("troca a linha 152 do PoolService")).toBeNull()
  })

  test("sem conector -> null (é desempate normal, não composta)", () => {
    expect(detectarComposta("diagnostica corrige")).toBeNull()
  })

  test("conversa -> null", () => {
    expect(detectarComposta("oi tudo bem")).toBeNull()
  })
})

describe("4.3 — detectarContradicao", () => {
  test("flip-flop no mesmo arquivo (X->Y depois Y->X) é contradição", () => {
    const ant = [{ arquivo: "f.ts", ancora: "X", novo: "Y" }]
    expect(detectarContradicao(ant, { arquivo: "f.ts", ancora: "Y", novo: "X" })).toBe(true)
  })

  test("salvaguarda de escopo: arquivos diferentes não conflitam", () => {
    const ant = [{ arquivo: "f.ts", ancora: "X", novo: "Y" }]
    expect(detectarContradicao(ant, { arquivo: "g.ts", ancora: "Y", novo: "X" })).toBe(false)
  })

  test("repetir a MESMA direção (X->Y de novo) não é contradição", () => {
    const ant = [{ arquivo: "f.ts", ancora: "X", novo: "Y" }]
    expect(detectarContradicao(ant, { arquivo: "f.ts", ancora: "X", novo: "Y" })).toBe(false)
  })

  test("edição não relacionada não é contradição", () => {
    const ant = [{ arquivo: "f.ts", ancora: "X", novo: "Y" }]
    expect(detectarContradicao(ant, { arquivo: "f.ts", ancora: "A", novo: "B" })).toBe(false)
  })
})
