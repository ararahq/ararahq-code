import { describe, expect, test } from "bun:test"
import { derivarEstado } from "./executor"

describe("derivarEstado", () => {
  test("sem desfecho (execução morreu) vira erro", () => {
    expect(derivarEstado(null, 0)).toBe("erro")
    expect(derivarEstado(null, 3)).toBe("erro")
  })

  test("concluiu sem editar vira sem-mudanca, independente do gate", () => {
    expect(derivarEstado({ resposta: "diagnóstico", gate: "sem-gate" }, 0)).toBe("sem-mudanca")
    expect(derivarEstado({ resposta: "ok", gate: "verde" }, 0)).toBe("sem-mudanca")
  })

  test("editou com build verde vira verde", () => {
    expect(derivarEstado({ resposta: "pronto", gate: "verde" }, 2)).toBe("verde")
  })

  test("editou com build vermelho vira vermelho — nunca declara pronto", () => {
    expect(derivarEstado({ resposta: "não fechou", gate: "vermelho" }, 1)).toBe("vermelho")
  })

  test("editou sem gate determinável (ou ambiente) vira sem-gate", () => {
    expect(derivarEstado({ resposta: "editado", gate: "sem-gate" }, 1)).toBe("sem-gate")
    expect(derivarEstado({ resposta: "runtime incompatível", gate: "ambiente" }, 1)).toBe("sem-gate")
  })
})
