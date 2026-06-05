import {
  decidirModo,
  detectarComposta,
  temStackTrace,
  tamanhoPrevisto,
  respostaHedge,
  type Modo,
} from "../engine/marques"
import type { IndiceParaRef } from "../engine/refcodigo"
import { pareceLoopLongo } from "./planner"

// As 5 marchas do sistema Jade. O usuário vê só "Jade"; por baixo, cada marcha é um modelo
// (preços OpenRouter em USD por 1M tokens). M1 (trivial) roda local no Ollama, custo ~zero.
export const MODELOS = {
  execucao: "deepseek/deepseek-v4-flash",
  diagnostico: "deepseek/deepseek-v4-pro",
  loopLongo: "moonshotai/kimi-k2.6",
  // Copiloto — compreender: contexto longo barato (1M), volume de leitura, não insight.
  compreender: "deepseek/deepseek-v4-flash",
} as const

export const CUSTO: Record<string, { in: number; out: number }> = {
  "deepseek/deepseek-v4-flash": { in: 0.0983, out: 0.1966 },
  "deepseek/deepseek-v4-pro": { in: 0.435, out: 0.87 },
  "google/gemini-3.1-pro-preview": { in: 2.0, out: 12.0 },
  "openai/gpt-5.5": { in: 5.0, out: 30.0 },
  "anthropic/claude-opus-4.8": { in: 5.0, out: 25.0 },
  "moonshotai/kimi-k2.6": { in: 0.68, out: 3.42 },
}

export type Decisao = {
  modo: Modo
  thinking: boolean
  modelo: string
  motivo: string
  // 3.6 — input com 3+ intenções numa frase só: o agent não roteia, pede pro usuário quebrar.
  pedirQuebra?: boolean
}

// 3.0 herança de contexto: guarda o diagnóstico mastigado da última tarefa que cravou (persiste
// entre tarefas; some no restart do processo). Um seguimento curto ("agora aplica isso") aplica
// ESSE diagnóstico em vez de re-diagnosticar — evita rodar diagnóstico sobre input vazio. A decisão
// de herdar é do agent (precisa do mastigado guardado); rotear continua puro sobre o input.
let _ultimoMastigado: string | null = null

export function registrarMastigado(tarefa: string | null): void {
  _ultimoMastigado = tarefa
}

export function mastigadoAnterior(): string | null {
  return _ultimoMastigado
}

export function resetSessao(): void {
  _ultimoMastigado = null
}

/**
 * Árvore de decisão das marchas Jade (3.0). Em ordem de prioridade: conversa > stack trace colado
 * (bug real, força diagnóstico forte) > tamanho/escopo grande (loop longo, Kimi) > diagnóstico >
 * execução. Decide modo, thinking on/off, modelo e o motivo (só log interno — o usuário vê só "Jade").
 * Função pura sobre o input. A herança de contexto (seguimento) é resolvida no agent.
 */
export function rotear(input: string, indice?: IndiceParaRef): Decisao {
  // 3.6 — tarefa composta: 3+ intenções => pede pra quebrar; diag+exec encadeados => força
  // diagnóstico-primeiro (o pipeline M3->M5 aplica a correção), em vez de o desempate de
  // decidirModo escolher errado (executar sem diagnosticar quando há um arquivo citado).
  const composta = detectarComposta(input, indice)
  if (composta?.tipo === "demais") {
    return { modo: "diagnostico", thinking: false, modelo: MODELOS.diagnostico, motivo: "muitas-intencoes", pedirQuebra: true }
  }
  const modo = composta ? "diagnostico" : decidirModo(input, indice)
  if (modo === "conversa") return { modo, thinking: false, modelo: MODELOS.execucao, motivo: "conversa" }
  // Copiloto — compreender: explicação/panorama, contexto longo barato, thinking OFF, não edita.
  if (modo === "compreender") return { modo, thinking: false, modelo: MODELOS.compreender, motivo: "compreender" }
  // Copiloto — planejar: plano pro humano aprovar. Reusa M3 (raciocínio) numa passada, NÃO executa.
  if (modo === "planejar") return { modo, thinking: true, modelo: MODELOS.diagnostico, motivo: "planejar" }
  // Copiloto — comunicar: commit/PR/changelog em PT-BR. Reusa M2 (barato) — é escrita, não raciocínio.
  if (modo === "comunicar") return { modo, thinking: false, modelo: MODELOS.execucao, motivo: "comunicar" }
  if (temStackTrace(input)) {
    return { modo: "diagnostico", thinking: true, modelo: MODELOS.diagnostico, motivo: "stack-trace" }
  }
  const tamanho = tamanhoPrevisto(input)
  if (pareceLoopLongo(input) || tamanho === "grande") {
    const motivo = tamanho === "grande" ? "tamanho-grande" : "loop-longo"
    return { modo, thinking: modo === "diagnostico", modelo: MODELOS.loopLongo, motivo }
  }
  if (modo === "diagnostico") return { modo, thinking: true, modelo: MODELOS.diagnostico, motivo: "diagnostico" }
  return { modo, thinking: false, modelo: MODELOS.execucao, motivo: "execucao" }
}

// Cadeia de escalada de modelo de EXECUÇÃO (D5): v4-flash -> Kimi (loop longo). Diagnóstico tem
// sua própria cadeia de fallback invisível (proximoFallbackDiagnostico), não usa esta.
const ESCALADA: string[] = [MODELOS.execucao, MODELOS.loopLongo]

export type EstadoEscalada = { modeloAtual: string }

/**
 * Próximo degrau da escalada de modelo. Função pura testável.
 * Devolve o modelo seguinte na cadeia, ou null se já está no topo (Kimi).
 */
export function proximoModeloEscalada(estado: EstadoEscalada): string | null {
  const idx = ESCALADA.indexOf(estado.modeloAtual)
  if (idx < 0) return ESCALADA[1] ?? null
  return ESCALADA[idx + 1] ?? null
}

export type Esforco = { modelo: string; thinking: boolean }

/**
 * 3.4 — Test-time compute graduado. Antes de pagar um modelo MAIOR, sobe o esforço (thinking) no
 * MESMO modelo — é mais barato. Só quando já está pensando (esforço no teto) é que troca de marcha.
 * Devolve o próximo degrau, ou null quando não há mais pra onde subir. Função pura testável.
 */
export function subirEsforco(atual: Esforco): Esforco | null {
  if (!atual.thinking) return { modelo: atual.modelo, thinking: true }
  const proximo = proximoModeloEscalada({ modeloAtual: atual.modelo })
  return proximo ? { modelo: proximo, thinking: true } : null
}

/**
 * 3.5 — Reclassificação dinâmica. Uma tarefa roteada como EXECUÇÃO que, após a 1ª passada, não
 * editou nada e devolveu resposta hedge (o modelo não soube o que mudar) era, na real, um
 * DIAGNÓSTICO disfarçado. Sinaliza pro agent pivotar pro pipeline de diagnóstico sem recomeçar.
 */
export function deveReclassificarPraDiagnostico(modo: Modo, houveEdicao: boolean, resposta: string): boolean {
  if (modo !== "execucao") return false
  if (houveEdicao) return false
  return respostaHedge(resposta)
}

// Cadeia de fallback INVISÍVEL do diagnóstico (M3, D6). COMEÇA BARATO: v4-flash ($0.0983/$0.1966).
// Bug simples com contexto bom o barato crava. O titular do raciocínio é o v4-pro (SWE 80.6% por uma
// fração do custo). Só escala (gemini -> gpt-5.5 -> opus-4.8) quando trava E o material justifica (par
// preciso). O quanto escala é decidido pela QUALIDADE do material no diagnosticarComFallback, não aqui.
export const CADEIA_DIAGNOSTICO: string[] = [
  MODELOS.execucao,
  MODELOS.diagnostico,
  "google/gemini-3.1-pro-preview",
  "openai/gpt-5.5",
  "anthropic/claude-opus-4.8",
]

/**
 * Próximo modelo na cadeia de fallback do diagnóstico. Função pura testável (D6).
 * Devolve o modelo seguinte, ou null se já está no topo (Opus) ou o modelo é desconhecido.
 */
export function proximoFallbackDiagnostico(modeloAtual: string): string | null {
  const idx = CADEIA_DIAGNOSTICO.indexOf(modeloAtual)
  if (idx < 0) return null
  return CADEIA_DIAGNOSTICO[idx + 1] ?? null
}

export function custoUSD(modelo: string, inTok: number, outTok: number): number {
  const c = CUSTO[modelo]
  if (!c) return 0
  return (inTok / 1_000_000) * c.in + (outTok / 1_000_000) * c.out
}
