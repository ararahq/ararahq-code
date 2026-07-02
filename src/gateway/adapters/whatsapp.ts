import type { TarefaNormalizada } from "../../autonomo/tipos"
import { ehObjeto, ehString, separarRepo } from "../texto"

// WhatsApp (Meta Cloud API): mensagem de texto vira tarefa. dedupeKey = id da mensagem — a Meta
// retenta agressivamente, então o retry cai no UNIQUE da fila e morre ali. Shape do payload é
// externo: cada campo tem type guard; shape errado devolve [] (ignora), nunca crasha.

export function extrairWhatsApp(payload: unknown): TarefaNormalizada[] {
  if (!ehObjeto(payload) || !Array.isArray(payload.entry)) return []
  const tarefas: TarefaNormalizada[] = []
  for (const entry of payload.entry) {
    if (!ehObjeto(entry) || !Array.isArray(entry.changes)) continue
    for (const change of entry.changes) {
      if (!ehObjeto(change) || !ehObjeto(change.value) || !Array.isArray(change.value.messages)) continue
      for (const msg of change.value.messages) {
        if (!ehObjeto(msg) || msg.type !== "text") continue
        if (!ehString(msg.id) || !ehString(msg.from)) continue
        const texto = ehObjeto(msg.text) && ehString(msg.text.body) ? msg.text.body.trim() : ""
        if (!texto) continue
        const { repo, instrucao } = separarRepo(texto)
        tarefas.push({
          dedupeKey: `wa:${msg.id}`,
          origem: "whatsapp",
          repo,
          instrucao,
          autor: msg.from,
          resposta: { origem: "whatsapp", para: msg.from },
        })
      }
    }
  }
  return tarefas
}
