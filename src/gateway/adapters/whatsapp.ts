import type { TarefaNormalizada } from "../../autonomo/tipos"
import { ehObjeto, ehString, separarRepo } from "../texto"

// WhatsApp (Meta Cloud API): mensagem de TEXTO ou IMAGEM (com legenda) vira tarefa. Na imagem, a
// legenda é a instrução e o media id fica pro gateway baixar (Media API + token) antes de despachar.
// dedupeKey = id da mensagem — a Meta retenta agressivamente, então o retry cai no UNIQUE da fila e
// morre ali. Shape do payload é externo: cada campo tem type guard; shape errado devolve [], nunca crasha.

/** Extrai (texto da instrução, media id de imagem) de UMA mensagem. null = mensagem ignorável. */
function conteudoDaMensagem(msg: Record<string, unknown>): { texto: string; imagemMediaId?: string } | null {
  if (msg.type === "text") {
    const texto = ehObjeto(msg.text) && ehString(msg.text.body) ? msg.text.body.trim() : ""
    return texto ? { texto } : null
  }
  if (msg.type === "image" && ehObjeto(msg.image)) {
    const legenda = ehString(msg.image.caption) ? msg.image.caption.trim() : ""
    const mediaId = ehString(msg.image.id) ? msg.image.id : undefined
    // Sem legenda a Jade não sabe o que fazer com a imagem — pede o texto (não adivinha).
    if (!legenda) return null
    return { texto: legenda, imagemMediaId: mediaId }
  }
  return null
}

export function extrairWhatsApp(payload: unknown): TarefaNormalizada[] {
  if (!ehObjeto(payload) || !Array.isArray(payload.entry)) return []
  const tarefas: TarefaNormalizada[] = []
  for (const entry of payload.entry) {
    if (!ehObjeto(entry) || !Array.isArray(entry.changes)) continue
    for (const change of entry.changes) {
      if (!ehObjeto(change) || !ehObjeto(change.value) || !Array.isArray(change.value.messages)) continue
      for (const msg of change.value.messages) {
        if (!ehObjeto(msg) || !ehString(msg.id) || !ehString(msg.from)) continue
        const conteudo = conteudoDaMensagem(msg)
        if (!conteudo) continue
        const { repo, instrucao } = separarRepo(conteudo.texto)
        tarefas.push({
          dedupeKey: `wa:${msg.id}`,
          origem: "whatsapp",
          repo,
          instrucao,
          autor: msg.from,
          resposta: { origem: "whatsapp", para: msg.from },
          ...(conteudo.imagemMediaId ? { imagemMediaId: conteudo.imagemMediaId } : {}),
        })
      }
    }
  }
  return tarefas
}
