// Entrada multimodal: a Jade aceita imagem (screenshot de bug, print de erro, mockup) junto do texto.
// O roteamento/grounding continua sobre o TEXTO (determinístico); a imagem entra no contexto do modelo
// nas passadas de raciocínio/execução. Formato de parte compatível com o AI SDK (data URL base64).

export type ParteImagem = { type: "image"; image: string; mediaType: string }

const MIME_POR_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

/** MIME de uma imagem pela extensão do caminho; null se não é imagem suportada. Puro. */
export function mimeDeImagem(caminho: string): string | null {
  const i = caminho.lastIndexOf(".")
  if (i < 0) return null
  return MIME_POR_EXT[caminho.slice(i + 1).toLowerCase()] ?? null
}

/** Monta uma parte de imagem a partir de bytes crus + mime. Pura (data URL base64), testável sem I/O. */
export function parteImagemDeBytes(bytes: Uint8Array, mediaType: string): ParteImagem {
  return { type: "image", image: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`, mediaType }
}

/** Lê uma imagem do disco e devolve a parte multimodal. null se não existe ou não é imagem suportada. */
export async function carregarImagem(caminho: string): Promise<ParteImagem | null> {
  const mime = mimeDeImagem(caminho)
  if (!mime) return null
  const f = Bun.file(caminho)
  if (!(await f.exists())) return null
  return parteImagemDeBytes(new Uint8Array(await f.arrayBuffer()), mime)
}

/**
 * Anexa as imagens à ÚLTIMA mensagem do usuário: o texto vira parte `text` e as imagens viram partes
 * `image`, na mesma mensagem (é onde o modelo espera o contexto visual da tarefa). Sem imagens ou sem
 * mensagem de usuário, devolve as mensagens intactas. Pura, testável. Tipagem frouxa (`any` de parte)
 * porque o AI SDK aceita conteúdo string OU array de partes — aqui a gente monta o array.
 */
export function anexarImagens<T extends { role: string; content: unknown }>(mensagens: T[], imagens: ParteImagem[]): T[] {
  if (!imagens.length) return mensagens
  for (let i = mensagens.length - 1; i >= 0; i--) {
    if (mensagens[i].role !== "user") continue
    const texto = typeof mensagens[i].content === "string" ? (mensagens[i].content as string) : ""
    const partes = [...(texto ? [{ type: "text", text: texto }] : []), ...imagens]
    return mensagens.map((m, j) => (j === i ? ({ ...m, content: partes } as unknown as T) : m))
  }
  return mensagens
}
