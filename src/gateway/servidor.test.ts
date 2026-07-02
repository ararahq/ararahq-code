import { describe, expect, test } from "bun:test"
import { criarHandler } from "./servidor"
import { Fila } from "./fila"
import { hmacSha256Hex } from "./assinatura"
import type { RelatorioExecucao } from "../autonomo/tipos"

const ENV = {
  JADE_WHATSAPP_APP_SECRET: "meta-secret",
  JADE_WHATSAPP_VERIFY_TOKEN: "verify-me",
  JADE_JIRA_WEBHOOK_SECRET: "jira-secret",
  JADE_CALLBACK_SECRET: "callback-secret",
}

const PAYLOAD_WA = JSON.stringify({
  entry: [
    {
      changes: [
        { value: { messages: [{ type: "text", id: "wamid.7", from: "5511988887777", text: { body: "conserta o bug" } }] } },
      ],
    },
  ],
})

function reqWhatsApp(corpo: string, assinatura: string | null): Request {
  return new Request("http://gw/webhooks/whatsapp", {
    method: "POST",
    body: corpo,
    headers: assinatura ? { "x-hub-signature-256": assinatura } : {},
  })
}

describe("gateway handler", () => {
  test("assinatura Meta inválida -> 401 e NADA persiste", async () => {
    const fila = new Fila(":memory:")
    const handler = criarHandler(fila, ENV)
    const resp = await handler(reqWhatsApp(PAYLOAD_WA, `sha256=${"0".repeat(64)}`))
    expect(resp.status).toBe(401)
    expect(fila.pendentes()).toBe(0)
    fila.fechar()
  })

  test("assinatura Meta válida -> enfileira; retry da Meta não duplica", async () => {
    const fila = new Fila(":memory:")
    const handler = criarHandler(fila, ENV)
    const assinatura = `sha256=${hmacSha256Hex(ENV.JADE_WHATSAPP_APP_SECRET, PAYLOAD_WA)}`
    expect((await handler(reqWhatsApp(PAYLOAD_WA, assinatura))).status).toBe(200)
    expect((await handler(reqWhatsApp(PAYLOAD_WA, assinatura))).status).toBe(200)
    expect(fila.pendentes()).toBe(1)
    fila.fechar()
  })

  test("handshake da Meta ecoa o challenge só com verify_token certo", async () => {
    const fila = new Fila(":memory:")
    const handler = criarHandler(fila, ENV)
    const ok = await handler(
      new Request("http://gw/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42"),
    )
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe("42")
    const ruim = await handler(
      new Request("http://gw/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=42"),
    )
    expect(ruim.status).toBe(403)
    fila.fechar()
  })

  test("Jira sem segredo na URL -> 401; com segredo -> enfileira", async () => {
    const fila = new Fila(":memory:")
    const handler = criarHandler(fila, ENV)
    const corpo = JSON.stringify({
      webhookEvent: "comment_created",
      issue: { key: "ARA-1" },
      comment: { id: "5", body: "@jade roda os testes", author: { displayName: "M" } },
    })
    const sem = await handler(new Request("http://gw/webhooks/jira", { method: "POST", body: corpo }))
    expect(sem.status).toBe(401)
    const com = await handler(new Request("http://gw/webhooks/jira?secret=jira-secret", { method: "POST", body: corpo }))
    expect(com.status).toBe(200)
    expect(fila.pendentes()).toBe(1)
    fila.fechar()
  })

  test("callback do sandbox: HMAC válido conclui a tarefa; inválido -> 401", async () => {
    const fila = new Fila(":memory:")
    const handler = criarHandler(fila, ENV)
    // tarefa de origem cli: responderNaOrigem é no-op — o teste não sai pra rede
    fila.enfileirar({
      dedupeKey: "cli:1",
      origem: "cli",
      repo: null,
      instrucao: "tarefa",
      autor: "cli",
      resposta: { origem: "cli" },
    })
    const t = fila.proxima()!
    const relatorio: RelatorioExecucao = { estado: "verde", resposta: "pronto", arquivosEditados: ["a.ts"], diff: "", ms: 10 }
    const corpo = JSON.stringify({ tarefaId: t.id, relatorio, prUrl: "https://github.com/x/y/pull/1" })

    const semAssinatura = await handler(new Request("http://gw/interno/resultado", { method: "POST", body: corpo }))
    expect(semAssinatura.status).toBe(401)

    const ok = await handler(
      new Request("http://gw/interno/resultado", {
        method: "POST",
        body: corpo,
        headers: { "x-jade-assinatura": hmacSha256Hex(ENV.JADE_CALLBACK_SECRET, corpo) },
      }),
    )
    expect(ok.status).toBe(200)
    expect(fila.buscar(t.id)?.estado).toBe("concluida")
    fila.fechar()
  })

  test("rota desconhecida -> 404 com shape de erro padrão", async () => {
    const fila = new Fila(":memory:")
    const handler = criarHandler(fila, ENV)
    const resp = await handler(new Request("http://gw/qualquer", { method: "POST", body: "{}" }))
    expect(resp.status).toBe(404)
    const body = (await resp.json()) as { error: { code: string } }
    expect(body.error.code).toBe("NAO_ENCONTRADO")
    fila.fechar()
  })
})
