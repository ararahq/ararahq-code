import { processar, desfechoUltimaTarefa, type Desfecho } from "../agent/agent"
import { arquivosEditados } from "../agent/camada4"
import { rodar } from "../tools"
import { ativarHeadless } from "../terminal/ui"
import type { EstadoExecucao, RelatorioExecucao } from "./tipos"

// Executor autônomo — a Fase 1 do Devin-mode. Envelopa a máquina já provada (processar(): roteamento,
// maestro, test-gate, recovery) num contrato headless: entra uma instrução, sai um RelatorioExecucao.
// Nada interativo acontece aqui: ativarHeadless() garante que stdin nunca é lido e que comando
// perigoso é negado automaticamente (sem humano, não roda).

const MAX_DIFF = 60_000
const TIMEOUT_DIFF_MS = 20_000

/** Mapeia (desfecho do agente, nº de edições) -> estado do relatório. Puro/testável. */
export function derivarEstado(desfecho: Desfecho | null, editados: number): EstadoExecucao {
  if (!desfecho) return "erro"
  if (editados === 0) return "sem-mudanca"
  if (desfecho.gate === "verde") return "verde"
  if (desfecho.gate === "vermelho") return "vermelho"
  return "sem-gate" // "ambiente" incluso: a mudança pode estar certa, mas não dá pra provar aqui
}

function msgErro(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e)
  return m.length > 300 ? `${m.slice(0, 300)}…` : m
}

/**
 * Roda UMA tarefa de ponta a ponta, sem TTY, e devolve o relatório honesto: estado do portão de
 * build, resposta final do agente, arquivos editados e o diff. Nunca lança — erro vira estado "erro".
 */
export async function executarTarefa(instrucao: string): Promise<RelatorioExecucao> {
  ativarHeadless()
  const inicio = Date.now()
  try {
    await processar(instrucao)
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
    // git diff cobre os arquivos rastreados; arquivo CRIADO (untracked) aparece só na lista de editados.
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
