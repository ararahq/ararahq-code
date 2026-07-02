import type { RelatorioExecucao } from "../autonomo/tipos"
import {
  assinaturaDiscordValida,
  assinaturaLinearValida,
  assinaturaMetaValida,
  assinaturaSlackValida,
  hmacSha256Hex,
  igualConstante,
} from "./assinatura"
import { extrairJira } from "./adapters/jira"
import { extrairLinear } from "./adapters/linear"
import { extrairSlack } from "./adapters/slack"
import { extrairWhatsApp } from "./adapters/whatsapp"
import { interpretarDiscord } from "./adapters/discord"
import { Fila } from "./fila"
import { montarMensagemResultado, responderNaOrigem } from "./resposta"
import { ehObjeto, ehString } from "./texto"

// Gateway HTTP do Devin-mode: recebe webhook de cada origem, valida a assinatura ANTES de
// persistir qualquer coisa, normaliza e enfileira. O despachante consome a fila e sobe sandbox;
// o sandbox devolve o resultado em POST /interno/resultado (HMAC próprio) e o gateway responde
// na thread de origem. Handler puro (Request -> Response) = testável sem porta.

const PORTA_PADRAO = 8787

type Env = Record<string, string | undefined>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function parseJson(corpo: string): unknown {
  try {
    return JSON.parse(corpo)
  } catch {
    return null
  }
}

/** Handshake de verificação da Meta (GET): confere o verify_token constant-time e ecoa o challenge. */
function handshakeMeta(url: URL, env: Env): Response {
  const modo = url.searchParams.get("hub.mode")
  const token = url.searchParams.get("hub.verify_token")
  const challenge = url.searchParams.get("hub.challenge")
  const esperado = env.JADE_WHATSAPP_VERIFY_TOKEN
  if (modo === "subscribe" && esperado && token && igualConstante(token, esperado) && challenge) {
    return new Response(challenge, { status: 200 })
  }
  return json(403, { error: { code: "VERIFY_TOKEN_INVALIDO", message: "verify token não confere" } })
}

export function criarHandler(fila: Fila, env: Env = process.env) {
  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const rota = `${req.method} ${url.pathname}`

    if (rota === "GET /saude") return json(200, { ok: true, pendentes: fila.pendentes() })
    if (rota === "GET /webhooks/whatsapp") return handshakeMeta(url, env)

    if (req.method !== "POST") return json(404, { error: { code: "NAO_ENCONTRADO", message: "rota desconhecida" } })
    const corpoRaw = await req.text()

    switch (url.pathname) {
      case "/webhooks/whatsapp": {
        if (!assinaturaMetaValida(env.JADE_WHATSAPP_APP_SECRET ?? "", corpoRaw, req.headers.get("x-hub-signature-256"))) {
          return json(401, { error: { code: "ASSINATURA_INVALIDA", message: "assinatura Meta não confere" } })
        }
        for (const t of extrairWhatsApp(parseJson(corpoRaw))) fila.enfileirar(t)
        return json(200, { ok: true })
      }
      case "/webhooks/slack": {
        if (
          !assinaturaSlackValida(
            env.JADE_SLACK_SIGNING_SECRET ?? "",
            corpoRaw,
            req.headers.get("x-slack-request-timestamp"),
            req.headers.get("x-slack-signature"),
          )
        ) {
          return json(401, { error: { code: "ASSINATURA_INVALIDA", message: "assinatura Slack não confere" } })
        }
        const tarefas = extrairSlack(corpoRaw)
        for (const t of tarefas) fila.enfileirar(t)
        // resposta imediata do slash command; o resultado real chega depois via bot no canal
        return json(200, {
          response_type: "ephemeral",
          text: tarefas.length ? "🦜 Na fila — te respondo neste canal quando terminar." : "uso: /jade [dono/repo:] <tarefa>",
        })
      }
      case "/webhooks/discord": {
        if (
          !assinaturaDiscordValida(
            env.JADE_DISCORD_PUBLIC_KEY ?? "",
            corpoRaw,
            req.headers.get("x-signature-timestamp"),
            req.headers.get("x-signature-ed25519"),
          )
        ) {
          return json(401, { error: { code: "ASSINATURA_INVALIDA", message: "assinatura Discord não confere" } })
        }
        const int = interpretarDiscord(parseJson(corpoRaw))
        if (int.tipo === "ping") return json(200, { type: 1 })
        if (int.tipo === "comando") {
          fila.enfileirar(int.tarefa)
          // type 4 = resposta imediata com conteúdo; o resultado real chega depois via bot no canal
          return json(200, { type: 4, data: { content: "🦜 Na fila — te respondo neste canal quando terminar." } })
        }
        return json(200, { type: 4, data: { content: "uso: /jade [dono/repo:] <tarefa>" } })
      }
      case "/webhooks/linear": {
        if (!assinaturaLinearValida(env.JADE_LINEAR_WEBHOOK_SECRET ?? "", corpoRaw, req.headers.get("linear-signature"))) {
          return json(401, { error: { code: "ASSINATURA_INVALIDA", message: "assinatura Linear não confere" } })
        }
        for (const t of extrairLinear(parseJson(corpoRaw))) fila.enfileirar(t)
        return json(200, { ok: true })
      }
      case "/webhooks/jira": {
        // Jira não assina webhook: autentica pelo segredo compartilhado da URL, constant-time
        const segredo = env.JADE_JIRA_WEBHOOK_SECRET
        const recebido = url.searchParams.get("secret")
        if (!segredo || !recebido || !igualConstante(recebido, segredo)) {
          return json(401, { error: { code: "ASSINATURA_INVALIDA", message: "segredo do webhook Jira não confere" } })
        }
        for (const t of extrairJira(parseJson(corpoRaw))) fila.enfileirar(t)
        return json(200, { ok: true })
      }
      case "/interno/resultado": {
        // callback do sandbox: HMAC do corpo com o segredo interno, validado antes de tocar a fila
        const segredo = env.JADE_CALLBACK_SECRET
        const assinatura = req.headers.get("x-jade-assinatura")
        if (!segredo || !assinatura || !igualConstante(assinatura, hmacSha256Hex(segredo, corpoRaw))) {
          return json(401, { error: { code: "ASSINATURA_INVALIDA", message: "assinatura do callback não confere" } })
        }
        const body = parseJson(corpoRaw)
        if (!ehObjeto(body) || typeof body.tarefaId !== "number" || !ehObjeto(body.relatorio)) {
          return json(400, { error: { code: "PAYLOAD_INVALIDO", message: "esperado { tarefaId, relatorio, prUrl? }" } })
        }
        const tarefa = fila.buscar(body.tarefaId)
        if (!tarefa) return json(404, { error: { code: "TAREFA_NAO_ENCONTRADA", message: `tarefa ${body.tarefaId}` } })
        const relatorio = body.relatorio as unknown as RelatorioExecucao
        const prUrl = ehString(body.prUrl) ? body.prUrl : null
        const sucesso = relatorio.estado === "verde" || relatorio.estado === "sem-gate" || relatorio.estado === "sem-mudanca"
        fila.concluir(tarefa.id, sucesso ? "concluida" : "falhou", JSON.stringify({ estado: relatorio.estado, prUrl }))
        await responderNaOrigem(tarefa.resposta, montarMensagemResultado(relatorio, prUrl), env)
        return json(200, { ok: true })
      }
      default:
        return json(404, { error: { code: "NAO_ENCONTRADO", message: "rota desconhecida" } })
    }
  }
}

export function iniciarGateway(porta = Number(process.env.JADE_GATEWAY_PORTA ?? PORTA_PADRAO)): void {
  const fila = new Fila()
  const handler = criarHandler(fila)
  Bun.serve({ port: porta, fetch: handler })
  process.stderr.write(`${JSON.stringify({ nivel: "info", msg: "Gateway Jade no ar.", porta, em: new Date().toISOString() })}\n`)
}

if (import.meta.main) iniciarGateway()
