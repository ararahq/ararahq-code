import type { RefResposta, RelatorioExecucao } from "../autonomo/tipos"

const TIMEOUT_MS = 10_000

export function montarMensagemResultado(rel: RelatorioExecucao, prUrl: string | null): string {
  if (rel.estado === "verde" && prUrl) {
    return `✅ Pronto — build verde. PR: ${prUrl}\n\n${rel.resposta.slice(0, 1200)}`
  }
  if (rel.estado === "pre-existente" && prUrl) {
    return `✅ Consertei o que pediu. O build ainda não fecha verde, mas só por falhas que JÁ existiam antes (não são da minha mudança). PR: ${prUrl}\n\n${rel.resposta.slice(0, 1200)}`
  }
  if (rel.estado === "indeterminado" && prUrl) {
    return `⚠️ Corrigi a compilação. Sobraram testes falhando, mas o projeto não compilava antes — não sei dizer se já falhavam. Confere no PR: ${prUrl}\n\n${rel.resposta.slice(0, 1200)}`
  }
  if (rel.estado === "sem-gate" && prUrl) {
    return `⚠️ Feito, mas sem build/teste pra validar — revise o PR com cuidado: ${prUrl}\n\n${rel.resposta.slice(0, 1200)}`
  }
  if (rel.estado === "vermelho") {
    return `❌ Editei mas o build NÃO fechou verde — não abri PR como pronto.${prUrl ? ` Progresso parcial: ${prUrl}` : ""}\n\n${rel.resposta.slice(0, 1200)}`
  }
  if (rel.estado === "sem-mudanca") {
    return `ℹ️ Concluí sem editar código:\n\n${rel.resposta.slice(0, 1500)}`
  }
  return `❌ A execução falhou antes de concluir:\n\n${rel.resposta.slice(0, 1200)}`
}

function logGateway(msg: string, extra: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ nivel: "erro", msg, ...extra, em: new Date().toISOString() })}\n`)
}

async function post(url: string, body: unknown, headers: Record<string, string>): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!resp.ok) {
      logGateway("Falha ao responder na origem.", { status: resp.status, host: new URL(url).host })
      return false
    }
    return true
  } catch (e) {
    logGateway("Falha ao responder na origem.", { erro: (e as Error).message, host: new URL(url).host })
    return false
  }
}

export async function responderNaOrigem(ref: RefResposta, texto: string, env = process.env): Promise<boolean> {
  switch (ref.origem) {
    case "whatsapp": {
      const token = env.JADE_WHATSAPP_TOKEN
      const phoneId = env.JADE_WHATSAPP_PHONE_ID
      if (!token || !phoneId) {
        logGateway("WhatsApp sem JADE_WHATSAPP_TOKEN/JADE_WHATSAPP_PHONE_ID configurados.", {})
        return false
      }
      return post(
        `https://graph.facebook.com/v21.0/${phoneId}/messages`,
        { messaging_product: "whatsapp", to: ref.para, type: "text", text: { body: texto.slice(0, 4000) } },
        { Authorization: `Bearer ${token}` },
      )
    }
    case "slack": {
      const token = env.JADE_SLACK_BOT_TOKEN
      if (!token) {
        logGateway("Slack sem JADE_SLACK_BOT_TOKEN configurado.", {})
        return false
      }
      return post(
        "https://slack.com/api/chat.postMessage",
        { channel: ref.canalId, text: texto.slice(0, 4000) },
        { Authorization: `Bearer ${token}` },
      )
    }
    case "discord": {
      const token = env.JADE_DISCORD_BOT_TOKEN
      if (!token) {
        logGateway("Discord sem JADE_DISCORD_BOT_TOKEN configurado.", {})
        return false
      }
      return post(
        `https://discord.com/api/v10/channels/${ref.canalId}/messages`,
        { content: texto.slice(0, 2000) },
        { Authorization: `Bot ${token}` },
      )
    }
    case "linear": {
      const token = env.JADE_LINEAR_TOKEN
      if (!token) {
        logGateway("Linear sem JADE_LINEAR_TOKEN configurado.", {})
        return false
      }
      return post(
        "https://api.linear.app/graphql",
        {
          query: `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
          variables: { input: { issueId: ref.issueId, body: texto.slice(0, 8000) } },
        },
        { Authorization: token },
      )
    }
    case "jira": {
      const base = env.JADE_JIRA_BASE_URL
      const email = env.JADE_JIRA_EMAIL
      const token = env.JADE_JIRA_TOKEN
      if (!base || !email || !token) {
        logGateway("Jira sem JADE_JIRA_BASE_URL/JADE_JIRA_EMAIL/JADE_JIRA_TOKEN configurados.", {})
        return false
      }
      const auth = Buffer.from(`${email}:${token}`).toString("base64")

      return post(
        `${base.replace(/\/$/, "")}/rest/api/3/issue/${ref.issueKey}/comment`,
        {
          body: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: texto.slice(0, 8000) }] }],
          },
        },
        { Authorization: `Basic ${auth}` },
      )
    }
    case "cli":
      return true
  }
}
