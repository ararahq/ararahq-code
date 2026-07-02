export type NotificadorTools = {
  toolAcao(nome: string, detalhe: string): void
  toolResultado(resumo: string): void
  motivo(texto: string): void
  diff(removido: string, novo: string): void
  linhaComando(linha: string): void
  confirmar(pergunta: string): Promise<boolean>
}

const SILENCIOSO: NotificadorTools = {
  toolAcao() {},
  toolResultado() {},
  motivo() {},
  diff() {},
  linhaComando() {},
  confirmar: async () => false,
}

let atual: NotificadorTools = SILENCIOSO

export function configurarNotificador(n: NotificadorTools): void {
  atual = n
}

export function resetNotificador(): void {
  atual = SILENCIOSO
}

export function notificador(): NotificadorTools {
  return atual
}
