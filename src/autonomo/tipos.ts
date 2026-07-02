export type OrigemTarefa = "cli" | "whatsapp" | "discord" | "slack" | "linear" | "jira"

export type RefResposta =
  | { origem: "whatsapp"; para: string }
  | { origem: "slack"; canalId: string }
  | { origem: "discord"; canalId: string }
  | { origem: "linear"; issueId: string }
  | { origem: "jira"; issueKey: string }
  | { origem: "cli" }

export type TarefaNormalizada = {
  dedupeKey: string
  origem: OrigemTarefa
  repo: string | null
  instrucao: string
  autor: string
  resposta: RefResposta

  imagemMediaId?: string
}

export type EstadoExecucao = "verde" | "sem-gate" | "vermelho" | "pre-existente" | "indeterminado" | "sem-mudanca" | "erro"

export type RelatorioExecucao = {
  estado: EstadoExecucao
  resposta: string
  arquivosEditados: string[]
  diff: string
  ms: number
}
