import { Fila, type TarefaFila } from "../gateway/fila"
import { montarMensagemResultado, responderNaOrigem } from "../gateway/resposta"
import { criarDriverDocker } from "./docker"
import { criarDriverFly } from "./fly"

// Despachante: consome a fila e sobe UM sandbox efêmero por tarefa. O sandbox reporta o resultado
// direto pro gateway (callback HMAC) — o despachante só cuida do ciclo de vida: lançar, e marcar
// falha (avisando na origem) quando o sandbox nem sobe. Driver docker pra dev local, fly pra prod.

const INTERVALO_MS = 2_000
const MAX_SIMULTANEAS = Number(process.env.JADE_MAX_SANDBOXES ?? 3)

export type DriverSandbox = {
  nome: string
  executar(envVars: Record<string, string>): Promise<{ ok: boolean; erro?: string }>
}

export type EnvSandbox = { ok: true; vars: Record<string, string> } | { ok: false; motivo: string }

/**
 * Monta a env do sandbox a partir da tarefa + config do orquestrador. Pura/testável.
 * Sem repo resolvível ou sem credencial => a tarefa nem sobe (falha explicada, não timeout mudo).
 */
export function montarEnvSandbox(tarefa: TarefaFila, env: Record<string, string | undefined>): EnvSandbox {
  const repo = tarefa.repo ?? env.JADE_REPO_PADRAO
  if (!repo) return { ok: false, motivo: "sem repositório: use 'dono/repo: tarefa' ou configure JADE_REPO_PADRAO" }
  if (!env.JADE_GIT_TOKEN) return { ok: false, motivo: "orquestrador sem JADE_GIT_TOKEN configurado" }
  if (!env.OPENROUTER_API_KEY) return { ok: false, motivo: "orquestrador sem OPENROUTER_API_KEY configurada" }
  return {
    ok: true,
    vars: {
      JADE_TAREFA_JSON: JSON.stringify({ id: tarefa.id, repo, instrucao: tarefa.instrucao }),
      JADE_GIT_TOKEN: env.JADE_GIT_TOKEN,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      JADE_CALLBACK_URL: env.JADE_CALLBACK_URL ?? "",
      JADE_CALLBACK_SECRET: env.JADE_CALLBACK_SECRET ?? "",
      JADE_BRANCH_BASE: env.JADE_BRANCH_BASE ?? "main",
    },
  }
}

export function escolherDriver(env: Record<string, string | undefined>): DriverSandbox {
  return env.JADE_SANDBOX_DRIVER === "fly" ? criarDriverFly(env) : criarDriverDocker(env)
}

function logOrq(msg: string, extra: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ nivel: "info", msg, ...extra, em: new Date().toISOString() })}\n`)
}

async function falharSemSubir(fila: Fila, tarefa: TarefaFila, motivo: string): Promise<void> {
  fila.concluir(tarefa.id, "falhou", JSON.stringify({ estado: "erro", motivo }))
  await responderNaOrigem(
    tarefa.resposta,
    montarMensagemResultado({ estado: "erro", resposta: `[Jade] ${motivo}`, arquivosEditados: [], diff: "", ms: 0 }, null),
  )
}

/** Loop principal: enquanto houver vaga, tira da fila e lança sandbox. Nunca lança duas vezes a mesma. */
export async function rodarDespachante(fila = new Fila(), driver = escolherDriver(process.env)): Promise<never> {
  logOrq("Despachante no ar.", { driver: driver.nome, maxSimultaneas: MAX_SIMULTANEAS })
  let ativas = 0
  for (;;) {
    if (ativas < MAX_SIMULTANEAS) {
      const tarefa = fila.proxima()
      if (tarefa) {
        const montada = montarEnvSandbox(tarefa, process.env)
        if (!montada.ok) {
          logOrq("Tarefa recusada antes do sandbox.", { id: tarefa.id, motivo: montada.motivo })
          await falharSemSubir(fila, tarefa, montada.motivo)
          continue
        }
        ativas++
        logOrq("Sandbox lançado.", { id: tarefa.id, origem: tarefa.origem })
        void driver
          .executar(montada.vars)
          .then(async (r) => {
            if (!r.ok) {
              logOrq("Sandbox falhou ao subir/rodar.", { id: tarefa.id, erro: r.erro })
              // se o callback não concluiu a tarefa, o estado "rodando" indica que morreu no meio
              if (fila.buscar(tarefa.id)?.estado === "rodando") {
                await falharSemSubir(fila, tarefa, `o sandbox falhou: ${r.erro ?? "sem detalhe"}`)
              }
            }
          })
          .finally(() => {
            ativas--
          })
        continue
      }
    }
    await Bun.sleep(INTERVALO_MS)
  }
}

if (import.meta.main) void rodarDespachante()
