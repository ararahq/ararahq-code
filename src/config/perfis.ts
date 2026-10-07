// Perfis de roteamento de modelos. Módulo-folha (não importa nada interno) pra poder ser
// lido tanto pelo router quanto pelo provedor sem criar ciclo de import.
// Trocado via env JADE_PERFIL (lido no boot). Default = "padrao".

export type Provedor = "openrouter" | "ollama"

export interface PerfilModelos {
  execucao: string
  diagnostico: string
  loopLongo: string
  compreender: string
  // fallbacks de diagnóstico ALÉM de [execucao, diagnostico], do mais barato ao mais forte.
  cauda: readonly string[]
  provedor: Provedor
}

// Modelo local (Ollama) do perfil "local". PRECISA ter template de tools (function-calling),
// senão o loop agêntico não chama ferramenta. Default hermes3:8b: baixa recusa + tools nativo,
// testado emitindo tool-call via Ollama /v1. Dolphin puro NÃO serve (sem template de tools).
// Trocável por env: aponte pra um 70B num box com GPU (via OLLAMA_URL), um modelo abliterated, etc.
export const MODELO_LOCAL = (process.env.JADE_MODELO_LOCAL ?? "hermes3:8b").trim()

export const PERFIL_PADRAO = "padrao"

export const PERFIS: Record<string, PerfilModelos> = {
  // Recomendado. Modelos cloud fortes via OpenRouter.
  padrao: {
    execucao: "deepseek/deepseek-v4-flash",
    diagnostico: "deepseek/deepseek-v4-pro",
    loopLongo: "minimax/minimax-m3",
    compreender: "google/gemini-2.5-flash-lite",
    cauda: ["qwen/qwen3.7-plus", "z-ai/glm-5.2"],
    provedor: "openrouter",
  },
  // Menor recusa que AINDA suporta tool-calling no OpenRouter (família Mistral + Qwen).
  // Os fine-tunes uncensored de comunidade (Dolphin/Hermes/WizardLM) NÃO expõem
  // function-calling no OpenRouter e quebram o agente — por isso não estão aqui.
  uncensored: {
    execucao: "mistralai/mistral-small-3.2-24b-instruct",
    diagnostico: "mistralai/mistral-large-2512",
    loopLongo: "mistralai/devstral-2512",
    compreender: "mistralai/mistral-nemo",
    cauda: ["mistralai/mixtral-8x22b-instruct", "qwen/qwen3-coder-plus"],
    provedor: "openrouter",
  },
  // Uncensored-raiz: modelo LOCAL via Ollama. Nada sai da máquina, ninguém modera.
  // Uma marcha só (o modelo local) — o roteamento vira temperatura/prompt, não troca de peso.
  // Exige que o modelo tenha template de tools (senão o loop agêntico não chama ferramenta).
  local: {
    execucao: MODELO_LOCAL,
    diagnostico: MODELO_LOCAL,
    loopLongo: MODELO_LOCAL,
    compreender: MODELO_LOCAL,
    cauda: [MODELO_LOCAL],
    provedor: "ollama",
  },
}

export function perfilAtivo(env: Record<string, string | undefined> = process.env): string {
  const p = (env.JADE_PERFIL ?? "").trim().toLowerCase()
  return p in PERFIS ? p : PERFIL_PADRAO
}

export function provedorDoPerfil(env: Record<string, string | undefined> = process.env): Provedor {
  return PERFIS[perfilAtivo(env)]!.provedor
}
