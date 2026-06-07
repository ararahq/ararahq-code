import { test, expect, describe } from "bun:test"
import { resolve } from "path"
import { indexar } from "../conhecimento"
import { smellsAtivos, localizarComSmell, ehArquivoDeTeste } from "./smells"

const FIX = (nome: string) => resolve(import.meta.dir, "../../eval/fixtures", nome)

describe("smells — smellsAtivos (intent match, o elo determinístico)", () => {
  test("'não terminaram essa parte' ativa stub", () => {
    expect(smellsAtivos("uns botão que nem terminaram essa parte, dá erro").map((s) => s.classe)).toContain("stub")
  })

  test("'mensagem foi pra pessoa errada' ativa dedup", () => {
    expect(smellsAtivos("a mensagem foi pra pessoa errada, trocou o destinatário").map((s) => s.classe)).toContain("dedup")
  })

  test("'recebe duas vezes em vários servidores' ativa lock", () => {
    expect(smellsAtivos("recebe a mesma mensagem duas vezes, piora com vários servidores").map((s) => s.classe)).toContain("lock")
  })

  test("'qualquer um entra sem senha' ativa fail-open-auth", () => {
    expect(smellsAtivos("qualquer um entra sem senha nenhuma, senha em branco passa").map((s) => s.classe)).toContain("fail-open-auth")
  })

  test("'dá pra forjar a assinatura do webhook' ativa timing-compare", () => {
    expect(smellsAtivos("segurança falou que dá pra forjar a assinatura do webhook e se passar").map((s) => s.classe)).toContain("timing-compare")
  })

  test("sintoma genérico sem mecanismo não ativa nada (não chuta)", () => {
    expect(smellsAtivos("o sistema tá meio lento hoje de manhã")).toHaveLength(0)
  })
})

describe("smells — ehArquivoDeTeste (filtro de precisão grátis)", () => {
  test("reconhece test-code por path e por sufixo", () => {
    for (const p of ["src/foo/bar.test.ts", "app/tests/unit/x.py", "a/__tests__/b.js", "app/MutexTest.kt", "x/FooSpec.kt"]) {
      expect(ehArquivoDeTeste(p)).toBe(true)
    }
  })
  test("não confunde código de produção (Latest, contest, Service)", () => {
    for (const p of ["app/infra/mutex/Mutex.kt", "src/WalletService.kt", "src/Latest.kt", "app/contest/Form.kt"]) {
      expect(ehArquivoDeTeste(p)).toBe(false)
    }
  })
})

describe("smells — localizarComSmell (smell + lexical ranqueado, fixture twilio-refund)", () => {
  test("sintoma de perda ativa lost-msg e surge arquivo do mecanismo (catch), marcado smell:", async () => {
    const raiz = FIX("twilio-refund")
    const indice = await indexar(raiz, { force: true })
    const cand = await localizarComSmell(raiz, indice, "a mensagem some e não chega pro cliente", ["mensagem"])
    const sm = cand.find((c) => c.termos.some((t) => t.startsWith("smell:")))
    expect(sm).toBeDefined()
    expect(sm!.termos[0]).toContain("lost-msg")
  })

  test("sintoma sem mecanismo conhecido → só fallback lexical (zero smell)", async () => {
    const raiz = FIX("twilio-refund")
    const indice = await indexar(raiz, { force: true })
    const cand = await localizarComSmell(raiz, indice, "está meio devagar de manhã hoje", ["refund"])
    expect(cand.every((c) => !c.termos.some((t) => t.startsWith("smell:")))).toBe(true)
  })
})
