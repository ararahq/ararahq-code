import type { TarefaNormalizada } from "../../autonomo/tipos"
import { ehObjeto, ehString, separarRepo } from "../texto"

// Discord (interactions): PING (type 1) responde PONG; slash command /jade (type 2) vira tarefa.
// A resposta final vai pro CANAL via bot token (interaction token expira em 15min — curto demais).

export const DISCORD_PING = 1
export const DISCORD_COMANDO = 2

export type InteracaoDiscord =
  | { tipo: "ping" }
  | { tipo: "comando"; tarefa: TarefaNormalizada }
  | { tipo: "ignorar" }

export function interpretarDiscord(payload: unknown): InteracaoDiscord {
  if (!ehObjeto(payload)) return { tipo: "ignorar" }
  if (payload.type === DISCORD_PING) return { tipo: "ping" }
  if (payload.type !== DISCORD_COMANDO) return { tipo: "ignorar" }
  if (!ehObjeto(payload.data) || payload.data.name !== "jade") return { tipo: "ignorar" }
  if (!ehString(payload.id) || !ehString(payload.channel_id)) return { tipo: "ignorar" }

  const opcoes = Array.isArray(payload.data.options) ? payload.data.options : []
  const primeira = opcoes.find((o): o is Record<string, unknown> => ehObjeto(o) && ehString(o.value))
  const texto = primeira ? (primeira.value as string).trim() : ""
  if (!texto) return { tipo: "ignorar" }

  const autor =
    ehObjeto(payload.member) && ehObjeto(payload.member.user) && ehString(payload.member.user.username)
      ? payload.member.user.username
      : "discord"
  const { repo, instrucao } = separarRepo(texto)
  return {
    tipo: "comando",
    tarefa: {
      dedupeKey: `discord:${payload.id}`,
      origem: "discord",
      repo,
      instrucao,
      autor,
      resposta: { origem: "discord", canalId: payload.channel_id },
    },
  }
}
