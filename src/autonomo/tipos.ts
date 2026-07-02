// Tipos do modo autônomo (Devin-mode): a tarefa normalizada que entra (de qualquer origem —
// WhatsApp, Discord, Slack, Linear, Jira, CLI) e o relatório estruturado que sai. É o contrato
// entre gateway -> fila -> sandbox -> resposta na origem.

export type OrigemTarefa = "cli" | "whatsapp" | "discord" | "slack" | "linear" | "jira"

// Pra onde responder quando a tarefa terminar — cada origem tem seu endereço de thread.
// Slack/Discord usam canal + bot token (response_url expira em 30min e interaction token em 15min —
// tarefa autônoma dura mais que isso; o canal não expira).
export type RefResposta =
  | { origem: "whatsapp"; para: string } // wa_id do remetente
  | { origem: "slack"; canalId: string } // chat.postMessage via bot token
  | { origem: "discord"; canalId: string } // POST /channels/{id}/messages via bot token
  | { origem: "linear"; issueId: string } // comentário na issue
  | { origem: "jira"; issueKey: string } // comentário na issue
  | { origem: "cli" }

export type TarefaNormalizada = {
  dedupeKey: string // idempotência: retry agressivo do provider não vira tarefa duplicada
  origem: OrigemTarefa
  repo: string | null // "owner/nome"; null = o gateway aplica o repo padrão configurado
  instrucao: string
  autor: string
  resposta: RefResposta
  // Imagem anexada (ex.: screenshot do bug). WhatsApp manda o media id — o gateway baixa via Media API
  // (tem o token) e resolve pra bytes ANTES de despachar; o sandbox nunca vê o token da plataforma.
  imagemMediaId?: string
}

// verde: editou e o build/teste do subprojeto fechou. sem-gate: editou mas não havia gate
// determinável (ou era tarefa de leitura). vermelho: editou e o build NÃO fechou por falha NOVA que a
// edição introduziu — não vira PR como se estivesse pronto. pre-existente: editou, a mudança pedida
// está aplicada, mas o build segue vermelho SÓ por falhas que já existiam antes (não é culpa da
// edição) — vira PR com ressalva. sem-mudanca: concluiu sem editar. erro: morreu antes de concluir.
// indeterminado: corrigiu a compilação, mas o baseline não compilava — há testes falhando que não dá
// pra atribuir (regressão vs dívida anterior). Vira PR com ressalva honesta pedindo confirmação.
export type EstadoExecucao = "verde" | "sem-gate" | "vermelho" | "pre-existente" | "indeterminado" | "sem-mudanca" | "erro"

export type RelatorioExecucao = {
  estado: EstadoExecucao
  resposta: string
  arquivosEditados: string[]
  diff: string
  ms: number
}
