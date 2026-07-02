import type { DriverSandbox } from "./despachante"

// Driver Fly Machines (produção): sobe uma máquina efêmera por tarefa — boot em ~centenas de ms,
// cobrança por segundo, auto_destroy quando o processo sai. É o "sandbox barato onde nada roda na
// máquina do usuário": o container clona, trabalha, abre PR, reporta e MORRE. A env (com segredos)
// vai pela API da Fly em TLS; a máquina não fica de pé esperando nada.

const API = "https://api.machines.dev/v1"
const TIMEOUT_API_MS = 15_000

export function criarDriverFly(env: Record<string, string | undefined>): DriverSandbox {
  return {
    nome: "fly",
    async executar(envVars) {
      const token = env.FLY_API_TOKEN
      const app = env.JADE_FLY_APP
      const imagem = env.JADE_SANDBOX_IMAGEM
      if (!token || !app || !imagem) {
        return { ok: false, erro: "driver fly exige FLY_API_TOKEN, JADE_FLY_APP e JADE_SANDBOX_IMAGEM" }
      }
      try {
        const resp = await fetch(`${API}/apps/${app}/machines`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            config: {
              image: imagem,
              env: envVars,
              auto_destroy: true,
              restart: { policy: "no" },
              guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
            },
          }),
          signal: AbortSignal.timeout(TIMEOUT_API_MS),
        })
        if (!resp.ok) {
          return { ok: false, erro: `Fly API ${resp.status}: ${(await resp.text()).slice(0, 300)}` }
        }
        // a máquina roda sozinha e se destrói; o resultado chega pelo callback do sandbox
        return { ok: true }
      } catch (e) {
        return { ok: false, erro: `falha ao chamar a Fly API: ${(e as Error).message}` }
      }
    },
  }
}
