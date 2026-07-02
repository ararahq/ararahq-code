import { afterEach, describe, expect, test } from "bun:test"
import { configurarNotificador, notificador, resetNotificador } from "./notificador"

afterEach(() => resetNotificador())

describe("notificador dos tools", () => {
  test("default é silencioso e NEGA confirmação (seguro sem humano)", async () => {
    resetNotificador()
    expect(() => notificador().toolAcao("ler_arquivo", "a.ts")).not.toThrow()
    expect(await notificador().confirmar("rodar rm -r?")).toBe(false)
  })

  test("configurar troca a implementação usada pelos tools", async () => {
    const acoes: string[] = []
    configurarNotificador({
      toolAcao: (nome, detalhe) => void acoes.push(`${nome}:${detalhe}`),
      toolResultado: () => {},
      motivo: () => {},
      diff: () => {},
      linhaComando: () => {},
      confirmar: async () => true,
    })
    notificador().toolAcao("editar_arquivo", "b.ts")
    expect(acoes).toEqual(["editar_arquivo:b.ts"])
    expect(await notificador().confirmar("ok?")).toBe(true)
  })
})
