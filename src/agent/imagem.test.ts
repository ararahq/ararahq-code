import { describe, expect, test } from "bun:test"
import { mimeDeImagem, parteImagemDeBytes, anexarImagens } from "./imagem"

describe("mimeDeImagem", () => {
  test("reconhece formatos suportados por extensão", () => {
    expect(mimeDeImagem("bug.png")).toBe("image/png")
    expect(mimeDeImagem("/tmp/Print.JPG")).toBe("image/jpeg")
    expect(mimeDeImagem("a/b/c.jpeg")).toBe("image/jpeg")
    expect(mimeDeImagem("x.webp")).toBe("image/webp")
  })

  test("recusa não-imagem", () => {
    expect(mimeDeImagem("codigo.ts")).toBeNull()
    expect(mimeDeImagem("semextensao")).toBeNull()
    expect(mimeDeImagem("a.pdf")).toBeNull()
  })
})

describe("parteImagemDeBytes", () => {
  test("monta data URL base64 com o mime", () => {
    const p = parteImagemDeBytes(new Uint8Array([1, 2, 3]), "image/png")
    expect(p.type).toBe("image")
    expect(p.mediaType).toBe("image/png")
    expect(p.image).toBe("data:image/png;base64,AQID")
  })
})

describe("anexarImagens", () => {
  const img = parteImagemDeBytes(new Uint8Array([0]), "image/png")

  test("converte a última mensagem de usuário em partes texto+imagem", () => {
    const msgs = [
      { role: "user", content: "contexto antigo" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "conserta o modal" },
    ]
    const out = anexarImagens(msgs, [img])

    expect(out[0].content).toBe("contexto antigo")
    expect(Array.isArray(out[2].content)).toBe(true)
    const partes = out[2].content as unknown as Array<{ type: string; text?: string }>
    expect(partes[0]).toEqual({ type: "text", text: "conserta o modal" })
    expect(partes[1]).toEqual(img)
  })

  test("sem imagens, devolve as mensagens intactas (mesma referência)", () => {
    const msgs = [{ role: "user", content: "oi" }]
    expect(anexarImagens(msgs, [])).toBe(msgs)
  })

  test("sem mensagem de usuário, não quebra", () => {
    const msgs = [{ role: "assistant", content: "só isso" }]
    expect(anexarImagens(msgs, [img])).toEqual(msgs)
  })
})
