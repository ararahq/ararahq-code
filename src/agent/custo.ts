import { mkdir } from "node:fs/promises"

const ARQUIVO = `${process.env.HOME}/.arara/custo.json`
const MAX_HISTORICO = 50

export type Agregado = { tarefas: number; tokens: number; custoUSD: number }

export type RegistroTarefa = {
  modo: string
  modelo: string
  thinking: boolean
  tokens: number
  custoUSD: number
  ms: number
}

// Linha do histórico interno (admin): guarda o MODELO REAL (marcha) por tarefa. A fachada Jade
// nunca mostra isso na resposta — é só pra /custo admin e auditoria de qual marcha rodou.
export type LinhaHistorico = RegistroTarefa & { ts: string }
type Persistido = { meses: Record<string, Agregado>; historico?: LinhaHistorico[] }

const sessao: Agregado = { tarefas: 0, tokens: 0, custoUSD: 0 }

export function mesAtual(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

function vazio(): Agregado {
  return { tarefas: 0, tokens: 0, custoUSD: 0 }
}

async function ler(): Promise<Persistido> {
  try {
    const f = Bun.file(ARQUIVO)
    if (!(await f.exists())) return { meses: {}, historico: [] }
    const dados = (await f.json()) as Partial<Persistido>
    return { meses: dados.meses ?? {}, historico: dados.historico ?? [] }
  } catch {
    return { meses: {}, historico: [] }
  }
}

async function gravar(dados: Persistido): Promise<void> {
  try {
    await mkdir(`${process.env.HOME}/.arara`, { recursive: true })
    await Bun.write(ARQUIVO, JSON.stringify(dados, null, 2))
  } catch {
    // Persistência de métricas é auxiliar: falha aqui não pode derrubar a tarefa.
  }
}

/** Soma uma tarefa concluída na sessão (memória) e no mês corrente (disco), e loga a marcha real. */
export async function registrarTarefa(r: RegistroTarefa): Promise<void> {
  sessao.tarefas++
  sessao.tokens += r.tokens
  sessao.custoUSD += r.custoUSD

  const dados = await ler()
  const mes = mesAtual()
  const atual = dados.meses[mes] ?? vazio()
  dados.meses[mes] = {
    tarefas: atual.tarefas + 1,
    tokens: atual.tokens + r.tokens,
    custoUSD: atual.custoUSD + r.custoUSD,
  }
  const historico = dados.historico ?? []
  historico.push({ ...r, ts: new Date().toISOString() })
  dados.historico = historico.slice(-MAX_HISTORICO)
  await gravar(dados)
}

export function custoSessao(): Agregado {
  return { ...sessao }
}

export async function custoMes(mes = mesAtual()): Promise<Agregado> {
  const dados = await ler()
  return dados.meses[mes] ?? vazio()
}

/** Histórico interno (admin): últimas N tarefas com o MODELO REAL por trás da fachada Jade. */
export async function historicoTarefas(n = 10): Promise<LinhaHistorico[]> {
  const dados = await ler()
  return (dados.historico ?? []).slice(-n).reverse()
}
