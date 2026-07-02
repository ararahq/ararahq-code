import type { TarefaNormalizada } from "../../autonomo/tipos"
import { separarRepo } from "../texto"

export function extrairSlack(corpoForm: string): TarefaNormalizada[] {
  const p = new URLSearchParams(corpoForm)
  const texto = (p.get("text") ?? "").trim()
  const triggerId = p.get("trigger_id") ?? ""
  const canalId = p.get("channel_id") ?? ""
  if (!texto || !triggerId || !canalId) return []
  const { repo, instrucao } = separarRepo(texto)
  return [
    {
      dedupeKey: `slack:${triggerId}`,
      origem: "slack",
      repo,
      instrucao,
      autor: p.get("user_name") ?? "slack",
      resposta: { origem: "slack", canalId },
    },
  ]
}
