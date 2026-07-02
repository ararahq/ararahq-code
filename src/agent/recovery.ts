export const TETO_RECOVERY = 6
export const ERROS_CODIGO_PRA_ESCALAR = 3

export const TETO_TROCAS_MARCHA = 3

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

function assinatura(saida: string): string {
  return saida
    .toLowerCase()
    .replace(/\/[\w./-]+/g, "/p")
    .replace(/\d+/g, "n")
    .replace(/\s+/g, " ")
    .slice(0, 200)
}

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

export function podeTrocarMarcha(): boolean {
  return estado.trocasMarcha < TETO_TROCAS_MARCHA && estado.tentativas < TETO_RECOVERY
}

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

export function consumirEscalada(): void {
  estado.escaladaPendente = false
  estado.errosCodigo = 0
  estado.ultimaAssinatura = null
}
