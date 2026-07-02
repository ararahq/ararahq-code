import type { TarefaNormalizada } from "../../autonomo/tipos"
import { ehObjeto, ehString, limparMencaoJade, separarRepo } from "../texto"

// Jira Cloud: comment_created mencionando @jade vira tarefa; resposta volta como comentário na
// issue. Jira não assina webhook nativamente — a autenticação é o segredo compartilhado na URL,
// comparado constant-time no servidor ANTES de chegar aqui.

export function extrairJira(payload: unknown): TarefaNormalizada[] {
  if (!ehObjeto(payload) || payload.webhookEvent !== "comment_created") return []
  const comment = payload.comment
  const issue = payload.issue
  if (!ehObjeto(comment) || !ehObjeto(issue)) return []
  if (!ehString(comment.id) || !ehString(comment.body) || !ehString(issue.key)) return []
  if (!/@jade\b/i.test(comment.body)) return []

  const texto = limparMencaoJade(comment.body)
  if (!texto) return []
  const { repo, instrucao } = separarRepo(texto)
  const autor = ehObjeto(comment.author) && ehString(comment.author.displayName) ? comment.author.displayName : "jira"
  return [
    {
      dedupeKey: `jira:${issue.key}:${comment.id}`,
      origem: "jira",
      repo,
      instrucao,
      autor,
      resposta: { origem: "jira", issueKey: issue.key },
    },
  ]
}
