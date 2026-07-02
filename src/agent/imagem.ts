export type ParteImagem = { type: "image"; image: string; mediaType: string }

const MIME_POR_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

export function mimeDeImagem(caminho: string): string | null {
  const i = caminho.lastIndexOf(".")
  if (i < 0) return null
  return MIME_POR_EXT[caminho.slice(i + 1).toLowerCase()] ?? null
}

export function parteImagemDeBytes(bytes: Uint8Array, mediaType: string): ParteImagem {
  return { type: "image", image: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`, mediaType }
}

export async function carregarImagem(caminho: string): Promise<ParteImagem | null> {
  const mime = mimeDeImagem(caminho)
  if (!mime) return null
  const f = Bun.file(caminho)
  if (!(await f.exists())) return null
  return parteImagemDeBytes(new Uint8Array(await f.arrayBuffer()), mime)
}

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
