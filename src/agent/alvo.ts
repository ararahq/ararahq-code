import { extrairEntidades, ehGenerico } from "../engine/marques"
import { extrairArquivosCitados } from "../engine/refcodigo"
import { escopoDeArquivos, dentroDoEscopo } from "./camada4"

export type AlvoAncorado = { termos: string[]; arquivos: string[] }

const MIN_TERMO = 4

const MAX_ARQUIVOS_POR_TERMO = 6

const MAX_ALVOS = 3

const MIN_SCORE_ALVO = 0.5

function baseSemExt(caminho: string): string {
  const base = caminho.split("/").pop() ?? caminho
  return base.replace(/\.[^.]+$/, "").toLowerCase()
}

export function ancorarAlvo(input: string, arquivos: string[]): AlvoAncorado | null {
  if (extrairArquivosCitados(input).length) return null
  const termos = extrairEntidades(input).filter((t) => t.length >= MIN_TERMO && !ehGenerico(t))
  if (!termos.length) return null

  const bases = arquivos.map((a) => ({ caminho: a, base: baseSemExt(a) }))
  const porTermo = new Map<string, string[]>()
  for (const termo of termos) {
    const casados = bases.filter((b) => b.base.includes(termo)).map((b) => b.caminho)
    if (casados.length && casados.length <= MAX_ARQUIVOS_POR_TERMO) porTermo.set(termo, casados)
  }
  if (!porTermo.size) return null

  const score = new Map<string, number>()
  for (const casados of porTermo.values()) {
    for (const arq of casados) score.set(arq, (score.get(arq) ?? 0) + 1 / casados.length)
  }
  const topo = Math.max(...score.values())
  if (topo < MIN_SCORE_ALVO) return null
  const alvos = [...score].filter(([, s]) => s === topo).map(([a]) => a).sort()
  if (alvos.length > MAX_ALVOS) return null
  return { termos: [...porTermo.keys()], arquivos: alvos }
}

const RE_CONSERTO = /\b(consert\w*|corrig\w*|arrum\w*|fix\w*|resolv\w*|repar\w*)\b/i
const RE_SINTOMA =
  /\bn[ãa]o\s+(est[áa]\s+)?[\wáéíóúâêôãõç]+|\bquebrad\w*|\bparou\s+de\b|\bdeixou\s+de\b|\bbroken\b|\bdoesn'?t\b|\bnot\s+work\w*|\bstopped\b/i

export function pareceBugDeSintoma(input: string): boolean {
  return RE_CONSERTO.test(input) || RE_SINTOMA.test(input)
}

export function notaAncoragem(alvo: AlvoAncorado): string {
  return (
    `\n\nALVO APONTADO PELO USUÁRIO: ${alvo.arquivos.join(", ")} (casou com "${alvo.termos.join('", "')}" do pedido). ` +
    `A causa do sintoma deve estar NESSE arquivo, em algo que ele usa ou em quem o usa. ` +
    `Se o código do alvo já implementa corretamente o comportamento que o usuário diz que falha, NÃO procure um ` +
    `componente parecido pra consertar no lugar: diga que o alvo parece correto e o que precisa confirmar do sintoma.`
  )
}

const RE_LINHA_IMPORT =
  /^\s*(import\b|export\s+.*\bfrom\b|from\s+[\w.]+\s+import\b|(const|let|var)\s+.*=\s*require\s*\(|require(_relative)?\s*[("']|use\s+[A-Z]|#include\b|include\s+[A-Z])/

export function linhasDeImport(texto: string): string[] {
  return texto
    .split("\n")
    .filter((l) => RE_LINHA_IMPORT.test(l))
    .map((l) => l.toLowerCase())
}

function citaComoToken(linha: string, base: string): boolean {
  const escapado = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^a-z0-9_])${escapado}([^a-z0-9_]|$)`).test(linha)
}

export function conectadosPorImport(textoA: string, caminhoA: string, textoB: string, caminhoB: string): boolean {
  const baseA = baseSemExt(caminhoA)
  const baseB = baseSemExt(caminhoB)
  return (
    linhasDeImport(textoA).some((l) => citaComoToken(l, baseB)) ||
    linhasDeImport(textoB).some((l) => citaComoToken(l, baseA))
  )
}

export type VereditoAlvo = { ancorado: true } | { ancorado: false; foraDoAlvo: string[] }

export async function diagnosticoAncoraNoAlvo(
  alvo: AlvoAncorado,
  diagTexto: string,
  lerTexto: (arquivo: string) => Promise<string | null>,
): Promise<VereditoAlvo> {
  const citados = extrairArquivosCitados(diagTexto)
  if (!citados.length) return { ancorado: true }
  const escopo = escopoDeArquivos(alvo.arquivos)
  if (citados.some((c) => dentroDoEscopo(escopo, c))) return { ancorado: true }

  const textosAlvo: { caminho: string; texto: string }[] = []
  for (const arq of alvo.arquivos) {
    const t = await lerTexto(arq)
    if (t) textosAlvo.push({ caminho: arq, texto: t })
  }
  for (const citado of citados) {
    const textoCitado = await lerTexto(citado)
    if (!textoCitado) continue
    if (textosAlvo.some((a) => conectadosPorImport(a.texto, a.caminho, textoCitado, citado))) {
      return { ancorado: true }
    }
  }
  return { ancorado: false, foraDoAlvo: citados }
}

export function montarRespostaForaDoAlvo(alvo: AlvoAncorado, foraDoAlvo: string[], diagTexto: string): string {
  return (
    `Analisei o alvo que você apontou (${alvo.arquivos.join(", ")}) e, pelo código, ele parece implementar ` +
    `corretamente o comportamento que você descreveu como quebrado — não encontrei a causa nele.\n\n` +
    `O que encontrei foi um problema parecido em OUTRO ponto: ${foraDoAlvo.join(", ")}. Como você não pediu ` +
    `pra mexer aí, NÃO editei nada.\n\n` +
    `Como seguir: (1) se o sintoma que você viu é nesse outro ponto, confirma que eu aplico o conserto; ` +
    `(2) se é no alvo mesmo, me descreve o passo exato que falha (o que você clica e o que acontece) que eu ataco direto.\n\n` +
    `Diagnóstico do outro ponto, se quiser avaliar:\n${diagTexto}`
  )
}
