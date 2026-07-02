import type { TarefaNormalizada } from "../../autonomo/tipos"
import { ehObjeto, ehString, limparMencaoJade, separarRepo } from "../texto"

export function extrairLinear(payload: unknown): TarefaNormalizada[] {
  if (!ehObjeto(payload)) return []
  if (payload.type !== "Comment" || payload.action !== "create") return []
  const data = payload.data
  if (!ehObjeto(data) || !ehString(data.id) || !ehString(data.body)) return []
  if (!/@jade\b/i.test(data.body)) return []

  const issueId = ehString(data.issueId)
    ? data.issueId
    : ehObjeto(data.issue) && ehString(data.issue.id)
      ? data.issue.id
      : null
  if (!issueId) return []

  const texto = limparMencaoJade(data.body)
  if (!texto) return []
  const { repo, instrucao } = separarRepo(texto)
  const autor = ehObjeto(payload.actor) && ehString(payload.actor.name) ? payload.actor.name : "linear"
  return [
    {
      dedupeKey: `linear:${data.id}`,
      origem: "linear",
      repo,
      instrucao,
      autor,
      resposta: { origem: "linear", issueId },
    },
  ]
}
