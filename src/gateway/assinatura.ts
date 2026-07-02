import { createHmac, createPublicKey, timingSafeEqual, verify as verificarCrypto } from "node:crypto"

// Verificação de assinatura dos webhooks — SEMPRE constant-time e SEMPRE antes de qualquer
// persistência (a fila só vê payload já autenticado). Cada provider assina de um jeito:
// Meta/Linear = HMAC-SHA256 do corpo cru · Slack = HMAC de "v0:<ts>:<corpo>" · Discord = Ed25519.

/** Comparação constant-time. Tamanhos diferentes retornam false direto (assinatura tem tamanho fixo). */
export function igualConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function hmacSha256Hex(segredo: string, corpo: string): string {
  return createHmac("sha256", segredo).update(corpo, "utf8").digest("hex")
}

/** Meta (WhatsApp): header `X-Hub-Signature-256: sha256=<hex>` sobre o corpo cru. */
export function assinaturaMetaValida(appSecret: string, corpoRaw: string, header: string | null): boolean {
  if (!appSecret || typeof header !== "string") return false
  return igualConstante(header, `sha256=${hmacSha256Hex(appSecret, corpoRaw)}`)
}

const TOLERANCIA_TS_SEG = 300

/** Slack: `X-Slack-Signature: v0=<hex>` sobre "v0:<timestamp>:<corpo>", timestamp com tolerância anti-replay. */
export function assinaturaSlackValida(
  signingSecret: string,
  corpoRaw: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  agoraSeg = Math.floor(Date.now() / 1000),
): boolean {
  if (!signingSecret || typeof timestampHeader !== "string" || typeof signatureHeader !== "string") return false
  const ts = Number(timestampHeader)
  if (!Number.isFinite(ts) || Math.abs(agoraSeg - ts) > TOLERANCIA_TS_SEG) return false
  return igualConstante(signatureHeader, `v0=${hmacSha256Hex(signingSecret, `v0:${timestampHeader}:${corpoRaw}`)}`)
}

/** Linear: header `linear-signature` = HMAC-SHA256 hex do corpo cru com o signing secret do webhook. */
export function assinaturaLinearValida(segredo: string, corpoRaw: string, header: string | null): boolean {
  if (!segredo || typeof header !== "string") return false
  return igualConstante(header, hmacSha256Hex(segredo, corpoRaw))
}

// Chave pública Ed25519 crua (32 bytes) -> DER SPKI, que é o que o node:crypto aceita.
const PREFIXO_SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex")

/** Discord: Ed25519 sobre `<timestamp><corpo>` com a public key do app (hex). */
export function assinaturaDiscordValida(
  publicKeyHex: string,
  corpoRaw: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
): boolean {
  if (!publicKeyHex || typeof timestampHeader !== "string" || typeof signatureHeader !== "string") return false
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHeader)) return false
  try {
    const chave = createPublicKey({
      key: Buffer.concat([PREFIXO_SPKI_ED25519, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    })
    return verificarCrypto(null, Buffer.from(timestampHeader + corpoRaw, "utf8"), chave, Buffer.from(signatureHeader, "hex"))
  } catch {
    return false
  }
}
