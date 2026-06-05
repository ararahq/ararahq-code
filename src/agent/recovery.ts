// Tracker de recuperação POR TAREFA. Distinto dos caps de leitura/busca (8/5),
// do MAX_ITERACOES (24) e do MAX_RECOVERY (4, que é só threshold de mensagem).
// Aqui mora: teto global de tentativas e o gatilho de escalada de modelo.

export const TETO_RECOVERY = 6
export const ERROS_CODIGO_PRA_ESCALAR = 3
// 3.5 — teto de trocas de MARCHA (reclassificações) por tarefa. Distinto de escalar MODELO dentro da
// mesma marcha. Conta JUNTO com TETO_RECOVERY: o que estourar primeiro corta. Oscilar de natureza =
// sinal de que precisa de direção humana.
export const TETO_TROCAS_MARCHA = 3

// Sinais de erro de AMBIENTE (versão/ferramenta/dependência) vs erro de CÓDIGO (compilação/tipo).
const RE_AMBIENTE =
  /\b(command not found|not found|no such file|unsupported class file|java\.lang\.UnsupportedClassVersion|requires java|jdk|jvm|JAVA_HOME|invalid source release|gradle wrapper|could not (find|resolve|download)|connection refused|network|enoent|permission denied|cannot find module|module not found|unknown compiler option|sdk not found|no version of)\b/i

export type ResultadoRecovery = {
  origem: "codigo" | "ambiente"
  tentativas: number
  escalar: boolean
  estourou: boolean
}

type Estado = {
  tentativas: number
  errosCodigo: number
  ultimaAssinatura: string | null
  escaladaPendente: boolean
  trocasMarcha: number
}

let estado: Estado = nova()

function nova(): Estado {
  return { tentativas: 0, errosCodigo: 0, ultimaAssinatura: null, escaladaPendente: false, trocasMarcha: 0 }
}

export function resetRecovery(): void {
  estado = nova()
}

export function classificarOrigem(saida: string): "codigo" | "ambiente" {
  return RE_AMBIENTE.test(saida) ? "ambiente" : "codigo"
}

/** Normaliza a saída de erro pra detectar "mesmo ponto": tira números, caminhos absolutos e espaços. */
function assinatura(saida: string): string {
  return saida
    .toLowerCase()
    .replace(/\/[\w./-]+/g, "/p")
    .replace(/\d+/g, "n")
    .replace(/\s+/g, " ")
    .slice(0, 200)
}

/**
 * Registra uma falha de verificação. Conta no teto global e decide se a escalada de modelo
 * deve disparar (3 erros de código no MESMO ponto). Retorna o estado pro agent agir.
 */
export function registrarFalha(saida: string): ResultadoRecovery {
  estado.tentativas++
  const origem = classificarOrigem(saida)

  if (origem === "codigo") {
    const assin = assinatura(saida)
    if (assin === estado.ultimaAssinatura) estado.errosCodigo++
    else estado.errosCodigo = 1
    estado.ultimaAssinatura = assin
    if (estado.errosCodigo >= ERROS_CODIGO_PRA_ESCALAR) estado.escaladaPendente = true
  } else {
    estado.errosCodigo = 0
    estado.ultimaAssinatura = null
  }

  return {
    origem,
    tentativas: estado.tentativas,
    escalar: estado.escaladaPendente,
    estourou: estado.tentativas >= TETO_RECOVERY,
  }
}

/**
 * 3.5 — Ainda pode trocar de marcha? Só se NÃO estourou o teto de trocas (3) NEM o teto global de
 * tentativas (6) — o que vier primeiro corta. Função consultada antes de reclassificar.
 */
export function podeTrocarMarcha(): boolean {
  return estado.trocasMarcha < TETO_TROCAS_MARCHA && estado.tentativas < TETO_RECOVERY
}

/** 3.5 — Conta uma troca de marcha (reclassificação). Chamar ao efetivar o pivô de marcha. */
export function registrarTrocaMarcha(): { trocas: number; podeContinuar: boolean } {
  estado.trocasMarcha++
  return { trocas: estado.trocasMarcha, podeContinuar: podeTrocarMarcha() }
}

export function trocasMarcha(): number {
  return estado.trocasMarcha
}

export function escaladaPendente(): boolean {
  return estado.escaladaPendente
}

export function estourouTeto(): boolean {
  return estado.tentativas >= TETO_RECOVERY
}

/** Consome o gatilho de escalada (depois que o agent rodou a 2ª passada), pra não re-disparar. */
export function consumirEscalada(): void {
  estado.escaladaPendente = false
  estado.errosCodigo = 0
  estado.ultimaAssinatura = null
}
