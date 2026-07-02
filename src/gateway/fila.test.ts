import { describe, expect, test } from "bun:test"
import { Fila } from "./fila"
import type { TarefaNormalizada } from "../autonomo/tipos"

function tarefa(chave: string): TarefaNormalizada {
  return {
    dedupeKey: chave,
    origem: "whatsapp",
    repo: "ararahq/api",
    instrucao: "conserta o bug",
    autor: "5511999990000",
    resposta: { origem: "whatsapp", para: "5511999990000" },
  }
}

describe("Fila", () => {
  test("enfileira e o retry do provider (mesmo dedupe_key) é ignorado", () => {
    const fila = new Fila(":memory:")
    expect(fila.enfileirar(tarefa("wa:1"))).toBe(true)
    expect(fila.enfileirar(tarefa("wa:1"))).toBe(false)
    expect(fila.pendentes()).toBe(1)
    fila.fechar()
  })

  test("proxima() entrega em ordem e marca rodando — não sai duas vezes", () => {
    const fila = new Fila(":memory:")
    fila.enfileirar(tarefa("wa:1"))
    fila.enfileirar(tarefa("wa:2"))
    const a = fila.proxima()
    expect(a?.dedupeKey).toBe("wa:1")
    expect(a?.estado).toBe("rodando")
    const b = fila.proxima()
    expect(b?.dedupeKey).toBe("wa:2")
    expect(fila.proxima()).toBeNull()
    fila.fechar()
  })

  test("concluir grava estado e resultado; buscar devolve a ref de resposta intacta", () => {
    const fila = new Fila(":memory:")
    fila.enfileirar(tarefa("wa:9"))
    const t = fila.proxima()
    expect(t).not.toBeNull()
    fila.concluir(t!.id, "concluida", `{"estado":"verde"}`)
    const relida = fila.buscar(t!.id)
    expect(relida?.estado).toBe("concluida")
    expect(relida?.resposta).toEqual({ origem: "whatsapp", para: "5511999990000" })
    fila.fechar()
  })
})
