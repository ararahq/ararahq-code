import { createOpenRouter } from "@openrouter/ai-sdk-provider"

export class SemApiKey extends Error {
  constructor() {
    super("Defina OPENROUTER_API_KEY para usar o Jade Code (https://openrouter.ai/keys).")
    this.name = "SemApiKey"
  }
}

export function provedor() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim()
  if (!apiKey) throw new SemApiKey()
  return createOpenRouter({ apiKey })
}
