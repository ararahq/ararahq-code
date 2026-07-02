import { processar, desfechoUltimaTarefa, type Desfecho } from "../agent/agent"
import { arquivosEditados } from "../agent/camada4"
import { rodar } from "../tools"
import { ativarHeadless, ui } from "../terminal/ui"
import { configurarNotificador } from "../tools/notificador"
import type { ParteImagem } from "../agent/imagem"
import type { EstadoExecucao, RelatorioExecucao } from "./tipos"

const MAX_DIFF = 60_000
const TIMEOUT_DIFF_MS = 20_000

export function derivarEstado(desfecho: Desfecho | null, editados: number): EstadoExecucao {
  if (!desfecho) return "erro"
  if (editados === 0) return "sem-mudanca"
  if (desfecho.gate === "verde") return "verde"
  if (desfecho.gate === "vermelho") return "vermelho"
  if (desfecho.gate === "pre-existente") return "pre-existente"
  if (desfecho.gate === "indeterminado") return "indeterminado"
  return "sem-gate"
}

function msgErro(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e)
  return m.length > 300 ? `${m.slice(0, 300)}…` : m
}

export async function executarTarefa(instrucao: string, imagens: ParteImagem[] = []): Promise<RelatorioExecucao> {
  ativarHeadless()
  configurarNotificador(ui)
  const inicio = Date.now()
  try {
    await processar(instrucao, imagens)
  } catch (e) {
    return {
      estado: "erro",
      resposta: `[Jade] a execução falhou antes de concluir: ${msgErro(e)}`,
      arquivosEditados: arquivosEditados(),
      diff: "",
      ms: Date.now() - inicio,
    }
  }
  const desfecho = desfechoUltimaTarefa()
  const editados = arquivosEditados()
  let diff = ""
  if (editados.length) {

    diff = (await rodar("git diff", undefined, TIMEOUT_DIFF_MS)).saida.slice(0, MAX_DIFF)
  }
  return {
    estado: derivarEstado(desfecho, editados.length),
    resposta: desfecho?.resposta ?? "[Jade] a tarefa terminou sem resposta — trate como falha.",
    arquivosEditados: editados,
    diff,
    ms: Date.now() - inicio,
  }
}
