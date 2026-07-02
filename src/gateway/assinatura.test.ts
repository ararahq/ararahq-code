import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import {
  assinaturaDiscordValida,
  assinaturaLinearValida,
  assinaturaMetaValida,
  assinaturaSlackValida,
  hmacSha256Hex,
  igualConstante,
} from "./assinatura"

describe("igualConstante", () => {
  test("igual retorna true, diferente retorna false", () => {
    expect(igualConstante("abc", "abc")).toBe(true)
    expect(igualConstante("abc", "abd")).toBe(false)
    expect(igualConstante("abc", "abcd")).toBe(false)
    expect(igualConstante("", "")).toBe(true)
  })
})

describe("assinaturaMetaValida (WhatsApp)", () => {
  const segredo = "app-secret"
  const corpo = `{"entry":[]}`

  test("aceita a assinatura correta", () => {
    const header = `sha256=${hmacSha256Hex(segredo, corpo)}`
    expect(assinaturaMetaValida(segredo, corpo, header)).toBe(true)
  })

  test("rejeita assinatura errada, ausente e segredo vazio", () => {
    expect(assinaturaMetaValida(segredo, corpo, `sha256=${"0".repeat(64)}`)).toBe(false)
    expect(assinaturaMetaValida(segredo, corpo, null)).toBe(false)
    expect(assinaturaMetaValida("", corpo, `sha256=${hmacSha256Hex("", corpo)}`)).toBe(false)
  })

  test("rejeita corpo adulterado", () => {
    const header = `sha256=${hmacSha256Hex(segredo, corpo)}`
    expect(assinaturaMetaValida(segredo, corpo + "x", header)).toBe(false)
  })
})

describe("assinaturaSlackValida", () => {
  const segredo = "signing-secret"
  const corpo = "command=%2Fjade&text=oi"
  const agora = 1_700_000_000

  function assinar(ts: number): string {
    return `v0=${hmacSha256Hex(segredo, `v0:${ts}:${corpo}`)}`
  }

  test("aceita assinatura correta dentro da janela", () => {
    expect(assinaturaSlackValida(segredo, corpo, String(agora), assinar(agora), agora)).toBe(true)
  })

  test("rejeita timestamp velho (anti-replay)", () => {
    const velho = agora - 301
    expect(assinaturaSlackValida(segredo, corpo, String(velho), assinar(velho), agora)).toBe(false)
  })

  test("rejeita assinatura errada e headers ausentes", () => {
    expect(assinaturaSlackValida(segredo, corpo, String(agora), `v0=${"0".repeat(64)}`, agora)).toBe(false)
    expect(assinaturaSlackValida(segredo, corpo, null, assinar(agora), agora)).toBe(false)
    expect(assinaturaSlackValida(segredo, corpo, String(agora), null, agora)).toBe(false)
  })
})

describe("assinaturaLinearValida", () => {
  test("aceita HMAC correto e rejeita errado", () => {
    const corpo = `{"type":"Comment"}`
    expect(assinaturaLinearValida("seg", corpo, hmacSha256Hex("seg", corpo))).toBe(true)
    expect(assinaturaLinearValida("seg", corpo, hmacSha256Hex("outro", corpo))).toBe(false)
    expect(assinaturaLinearValida("seg", corpo, null)).toBe(false)
  })
})

describe("assinaturaDiscordValida (Ed25519)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  // chave pública crua (32 bytes finais do DER SPKI) em hex — formato que o Discord fornece
  const publicHex = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex")
  const corpo = `{"type":1}`
  const ts = "1700000000"

  test("aceita assinatura válida sobre timestamp+corpo", () => {
    const assinatura = sign(null, Buffer.from(ts + corpo, "utf8"), privateKey).toString("hex")
    expect(assinaturaDiscordValida(publicHex, corpo, ts, assinatura)).toBe(true)
  })

  test("rejeita assinatura sobre outro corpo, hex malformado e chave errada", () => {
    const assinatura = sign(null, Buffer.from(ts + corpo, "utf8"), privateKey).toString("hex")
    expect(assinaturaDiscordValida(publicHex, corpo + "x", ts, assinatura)).toBe(false)
    expect(assinaturaDiscordValida(publicHex, corpo, ts, "zz")).toBe(false)
    expect(assinaturaDiscordValida("ab".repeat(32), corpo, ts, assinatura)).toBe(false)
    expect(assinaturaDiscordValida(publicHex, corpo, null, assinatura)).toBe(false)
  })
})
