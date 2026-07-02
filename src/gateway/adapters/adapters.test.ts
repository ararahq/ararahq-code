import { describe, expect, test } from "bun:test"
import { extrairWhatsApp } from "./whatsapp"
import { extrairSlack } from "./slack"
import { interpretarDiscord } from "./discord"
import { extrairLinear } from "./linear"
import { extrairJira } from "./jira"
import { limparMencaoJade, separarRepo } from "../texto"

describe("separarRepo", () => {
  test("prefixo dono/repo: aponta o repositório", () => {
    expect(separarRepo("ararahq/api: conserta o timeout do webhook")).toEqual({
      repo: "ararahq/api",
      instrucao: "conserta o timeout do webhook",
    })
  })

  test("dois-pontos sem cara de repo NÃO vira repo", () => {
    expect(separarRepo("conserta o bug: o cache não invalida")).toEqual({
      repo: null,
      instrucao: "conserta o bug: o cache não invalida",
    })
  })
})

describe("limparMencaoJade", () => {
  test("remove a menção em qualquer capitalização", () => {
    expect(limparMencaoJade("@jade conserta o bug")).toBe("conserta o bug")
    expect(limparMencaoJade("por favor @Jade olha isso")).toBe("por favor olha isso")
  })
})

describe("extrairWhatsApp", () => {
  const payload = (texto: string) => ({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ type: "text", id: "wamid.123", from: "5511999990000", text: { body: texto } }],
            },
          },
        ],
      },
    ],
  })

  test("mensagem de texto vira tarefa com dedupe pelo id", () => {
    const [t] = extrairWhatsApp(payload("ararahq/api: conserta o bug"))
    expect(t.dedupeKey).toBe("wa:wamid.123")
    expect(t.repo).toBe("ararahq/api")
    expect(t.instrucao).toBe("conserta o bug")
    expect(t.resposta).toEqual({ origem: "whatsapp", para: "5511999990000" })
  })

  test("shape errado devolve [] sem crashar", () => {
    expect(extrairWhatsApp(null)).toEqual([])
    expect(extrairWhatsApp({})).toEqual([])
    expect(extrairWhatsApp({ entry: [{ changes: [{ value: { messages: [{ type: "text" }] } }] }] })).toEqual([])
    expect(extrairWhatsApp({ entry: [{ changes: [{ value: { messages: [{ type: "image", id: "x", from: "y" }] } }] }] })).toEqual([])
  })
})

describe("extrairSlack", () => {
  test("slash command vira tarefa com canal pra resposta", () => {
    const corpo = new URLSearchParams({
      command: "/jade",
      text: "ararahq/api: roda o lint",
      trigger_id: "trg.1",
      channel_id: "C042",
      user_name: "micael",
    }).toString()
    const [t] = extrairSlack(corpo)
    expect(t.dedupeKey).toBe("slack:trg.1")
    expect(t.repo).toBe("ararahq/api")
    expect(t.autor).toBe("micael")
    expect(t.resposta).toEqual({ origem: "slack", canalId: "C042" })
  })

  test("sem texto ou sem canal devolve []", () => {
    expect(extrairSlack("command=%2Fjade&trigger_id=t&channel_id=C")).toEqual([])
    expect(extrairSlack("command=%2Fjade&text=oi&trigger_id=t")).toEqual([])
  })
})

describe("interpretarDiscord", () => {
  test("PING vira pong", () => {
    expect(interpretarDiscord({ type: 1 })).toEqual({ tipo: "ping" })
  })

  test("slash command /jade vira tarefa", () => {
    const int = interpretarDiscord({
      type: 2,
      id: "int.9",
      channel_id: "ch.7",
      member: { user: { username: "micael" } },
      data: { name: "jade", options: [{ name: "tarefa", value: "conserta o build" }] },
    })
    expect(int.tipo).toBe("comando")
    if (int.tipo === "comando") {
      expect(int.tarefa.dedupeKey).toBe("discord:int.9")
      expect(int.tarefa.instrucao).toBe("conserta o build")
      expect(int.tarefa.resposta).toEqual({ origem: "discord", canalId: "ch.7" })
    }
  })

  test("outro comando, sem texto ou shape errado é ignorado", () => {
    expect(interpretarDiscord({ type: 2, data: { name: "outro" } }).tipo).toBe("ignorar")
    expect(interpretarDiscord({ type: 2, id: "i", channel_id: "c", data: { name: "jade", options: [] } }).tipo).toBe("ignorar")
    expect(interpretarDiscord(null).tipo).toBe("ignorar")
  })
})

describe("extrairLinear", () => {
  test("comentário com @jade vira tarefa na issue", () => {
    const [t] = extrairLinear({
      type: "Comment",
      action: "create",
      actor: { name: "Micael" },
      data: { id: "com.1", body: "@jade ararahq/api: adiciona paginação", issueId: "iss.5" },
    })
    expect(t.dedupeKey).toBe("linear:com.1")
    expect(t.repo).toBe("ararahq/api")
    expect(t.instrucao).toBe("adiciona paginação")
    expect(t.resposta).toEqual({ origem: "linear", issueId: "iss.5" })
  })

  test("sem menção @jade, evento errado ou shape errado devolve []", () => {
    expect(extrairLinear({ type: "Comment", action: "create", data: { id: "c", body: "sem mencao", issueId: "i" } })).toEqual([])
    expect(extrairLinear({ type: "Issue", action: "create", data: {} })).toEqual([])
    expect(extrairLinear(null)).toEqual([])
  })
})

describe("extrairJira", () => {
  test("comment_created com @jade vira tarefa na issue", () => {
    const [t] = extrairJira({
      webhookEvent: "comment_created",
      issue: { key: "ARA-42" },
      comment: { id: "10001", body: "@jade conserta o teste flaky", author: { displayName: "Micael" } },
    })
    expect(t.dedupeKey).toBe("jira:ARA-42:10001")
    expect(t.instrucao).toBe("conserta o teste flaky")
    expect(t.resposta).toEqual({ origem: "jira", issueKey: "ARA-42" })
  })

  test("sem menção ou shape errado devolve []", () => {
    expect(extrairJira({ webhookEvent: "comment_created", issue: { key: "A-1" }, comment: { id: "1", body: "oi" } })).toEqual([])
    expect(extrairJira({ webhookEvent: "issue_updated" })).toEqual([])
    expect(extrairJira(null)).toEqual([])
  })
})
