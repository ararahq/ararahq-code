import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cloneRaso, entregarPR } from "../entrega/git"
import { hmacSha256Hex } from "../gateway/assinatura"
import { indexar } from "../conhecimento"
import type { RelatorioExecucao } from "./tipos"

// Entrypoint do SANDBOX efêmero (container): clona o repo, roda a tarefa com o executor headless,
// entrega PR e reporta o resultado pro gateway via callback HMAC. O container morre depois — nada
// do cliente persiste na infra. Segurança: JADE_GIT_TOKEN e JADE_CALLBACK_SECRET são LIDOS e
// APAGADOS do process.env ANTES do agente rodar — código de terceiro (e o modelo, via
// rodar_comando `env`) não enxerga os segredos da plataforma. Só a OPENROUTER_API_KEY fica
// (é a chave do próprio usuário, BYOK, e o agente precisa dela).

const TIMEOUT_CALLBACK_MS = 10_000

type TarefaSandbox = { id: number; repo: string; instrucao: string }

function logSandbox(msg: string, extra: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ nivel: "info", msg, ...extra, em: new Date().toISOString() })}\n`)
}

function lerTarefa(raw: string | undefined): TarefaSandbox | null {
  if (!raw) return null
  try {
    const t = JSON.parse(raw) as Record<string, unknown>
    if (typeof t.id !== "number" || typeof t.repo !== "string" || typeof t.instrucao !== "string") return null
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(t.repo)) return null
    return { id: t.id, repo: t.repo, instrucao: t.instrucao }
  } catch {
    return null
  }
}

/** Consome uma env secreta: lê e APAGA do process.env — o agente roda sem enxergá-la. */
function consumirSegredo(nome: string): string {
  const v = process.env[nome] ?? ""
  delete process.env[nome]
  return v
}

async function reportar(
  callbackUrl: string,
  callbackSecret: string,
  tarefaId: number,
  relatorio: RelatorioExecucao,
  prUrl: string | null,
): Promise<void> {
  const corpo = JSON.stringify({ tarefaId, relatorio, prUrl })
  if (!callbackUrl) {
    // sem gateway (rodada local/debug): o relatório sai no stdout, mesmo contrato do --tarefa
    console.log(corpo)
    return
  }
  try {
    const resp = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-jade-assinatura": hmacSha256Hex(callbackSecret, corpo) },
      body: corpo,
      signal: AbortSignal.timeout(TIMEOUT_CALLBACK_MS),
    })
    if (!resp.ok) logSandbox("Callback recusado.", { status: resp.status })
  } catch (e) {
    logSandbox("Falha ao entregar o callback.", { erro: (e as Error).message })
  }
}

function relatorioDeErro(msg: string): RelatorioExecucao {
  return { estado: "erro", resposta: `[Jade] ${msg}`, arquivosEditados: [], diff: "", ms: 0 }
}

async function main(): Promise<number> {
  const tarefa = lerTarefa(process.env.JADE_TAREFA_JSON)
  const gitToken = consumirSegredo("JADE_GIT_TOKEN")
  const callbackSecret = consumirSegredo("JADE_CALLBACK_SECRET")
  const callbackUrl = process.env.JADE_CALLBACK_URL ?? ""
  const base = process.env.JADE_BRANCH_BASE ?? "main"

  if (!tarefa) {
    logSandbox("JADE_TAREFA_JSON ausente ou inválido — nada a fazer.")
    return 2
  }
  if (!gitToken) {
    await reportar(callbackUrl, callbackSecret, tarefa.id, relatorioDeErro("sandbox sem JADE_GIT_TOKEN — não consigo clonar."), null)
    return 2
  }

  logSandbox("Clonando repositório.", { repo: tarefa.repo, base })
  const dir = await mkdtemp(join(tmpdir(), "jade-repo-"))
  const clone = await cloneRaso(`https://github.com/${tarefa.repo}.git`, dir, gitToken, base)
  if (clone.code !== 0) {
    await reportar(
      callbackUrl,
      callbackSecret,
      tarefa.id,
      relatorioDeErro(`não consegui clonar ${tarefa.repo} (branch ${base}): ${clone.saida.slice(0, 300)}`),
      null,
    )
    return 1
  }
  process.chdir(dir)

  // Camada 1 antes do modelo: símbolos + grafo + stack. Best-effort — sem índice o agente degrada.
  try {
    const inicio = Date.now()
    await indexar(dir)
    logSandbox("Projeto indexado.", { ms: Date.now() - inicio })
  } catch (e) {
    logSandbox("Indexação falhou — seguindo sem índice.", { erro: (e as Error).message })
  }

  const { executarTarefa } = await import("./executor")
  logSandbox("Executando tarefa.", { id: tarefa.id })
  const rel = await executarTarefa(tarefa.instrucao)
  logSandbox("Tarefa executada.", { estado: rel.estado, arquivos: rel.arquivosEditados.length, ms: rel.ms })

  let prUrl: string | null = null
  if (rel.arquivosEditados.length && rel.estado !== "erro") {
    const entrega = await entregarPR({ cwd: dir, repo: tarefa.repo, base, instrucao: tarefa.instrucao, relatorio: rel, token: gitToken })
    if (entrega.ok) {
      prUrl = entrega.prUrl
      logSandbox("PR aberto.", { branch: entrega.branch })
    } else {
      // estado parcial explícito: a edição existe mas a entrega travou — o relatório diz onde
      rel.resposta = `${rel.resposta}\n\n[Jade] a entrega falhou no passo "${entrega.passo}": ${entrega.erro.slice(0, 300)}`
      logSandbox("Entrega falhou.", { passo: entrega.passo })
    }
  }

  await reportar(callbackUrl, callbackSecret, tarefa.id, rel, prUrl)
  return rel.estado === "erro" || rel.estado === "vermelho" ? 1 : 0
}

if (import.meta.main) {
  process.exit(await main())
}
