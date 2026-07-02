// Ancoragem no alvo citado (bug de sintoma). O modo de falha medido no teste do modal: o usuário
// aponta um componente ESPECÍFICO em prosa ("o X do modal de feedback não fecha"), a Jade conclui
// corretamente que o alvo está certo — e aí, em vez de retornar honesta, acha um problema PARECIDO
// em OUTRO componente, conserta o que ninguém pediu e declara verde. O test-gate prova "o build
// passa", não "resolvi o que foi pedido" — verde no alvo errado passa reto.
//
// O conserto: quando a prosa aponta um alvo que casa arquivo real (determinístico, zero modelo),
// (1) a investigação ancora nele (nota no sintoma + candidato prioritário), (2) o escopo de edição
// trava nele, e (3) um diagnóstico que crava FORA do alvo e sem conexão de import com ele vira
// abstenção honesta — lista o que achou e PERGUNTA, em vez de editar por conta.

import { extrairEntidades, ehGenerico } from "../engine/marques"
import { extrairArquivosCitados } from "../engine/refcodigo"
import { escopoDeArquivos, dentroDoEscopo } from "./camada4"

export type AlvoAncorado = { termos: string[]; arquivos: string[] }

const MIN_TERMO = 4
// Termo que casa basename demais é comum demais pra apontar um alvo (ex.: "modal", "service").
const MAX_ARQUIVOS_POR_TERMO = 6
// Mais arquivos que isso empatados no topo = o pedido é ambíguo; não ancora (diagnóstico livre assume).
const MAX_ALVOS = 3
// Score mínimo do topo: exige ao menos um termo razoavelmente distintivo (casa <= 2 arquivos).
const MIN_SCORE_ALVO = 0.5

/** Basename sem extensão, minúsculo — a unidade de casamento termo↔arquivo. */
function baseSemExt(caminho: string): string {
  const base = caminho.split("/").pop() ?? caminho
  return base.replace(/\.[^.]+$/, "").toLowerCase()
}

/**
 * O pedido em prosa aponta um alvo que casa arquivo real do repo? Pura, determinística: termos do
 * sintoma (Marques) contra os basenames, com peso 1/N por termo (termo que casa 1 arquivo pesa 1;
 * que casa 5 pesa 0.2) — "feedback" vence "modal" sem tabela fixa, derivado da estrutura real do
 * repo. Devolve null quando: o input já cita arquivo explícito (o caminho existente trata), nenhum
 * termo casa, o melhor casamento é fraco, ou o topo empata em arquivos demais (ambíguo).
 */
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

/** Nota anexada ao sintoma ANTES do diagnóstico: ancora a investigação no alvo apontado. */
export function notaAncoragem(alvo: AlvoAncorado): string {
  return (
    `\n\nALVO APONTADO PELO USUÁRIO: ${alvo.arquivos.join(", ")} (casou com "${alvo.termos.join('", "')}" do pedido). ` +
    `A causa do sintoma deve estar NESSE arquivo, em algo que ele usa ou em quem o usa. ` +
    `Se o código do alvo já implementa corretamente o comportamento que o usuário diz que falha, NÃO procure um ` +
    `componente parecido pra consertar no lugar: diga que o alvo parece correto e o que precisa confirmar do sintoma.`
  )
}

// Linha de import/require/include nas linguagens do repo (TS/JS, Kotlin/Java, Python, Go, PHP, Ruby).
const RE_LINHA_IMPORT =
  /^\s*(import\b|export\s+.*\bfrom\b|from\s+[\w.]+\s+import\b|(const|let|var)\s+.*=\s*require\s*\(|require(_relative)?\s*[("']|use\s+[A-Z]|#include\b|include\s+[A-Z])/

/** As linhas de import de um texto-fonte, minúsculas. Exportada pra teste. */
export function linhasDeImport(texto: string): string[] {
  return texto
    .split("\n")
    .filter((l) => RE_LINHA_IMPORT.test(l))
    .map((l) => l.toLowerCase())
}

/**
 * O basename aparece como TOKEN na linha (fronteira não-alfanumérica dos dois lados)? Substring pura
 * false-conecta: "a" (de a.tsx) casa dentro de "react". `"./feedback-widget"` e `com.arara.messageservice`
 * têm o basename delimitado por /, ., aspas ou fim de linha — é isso que a fronteira exige.
 */
function citaComoToken(linha: string, base: string): boolean {
  const escapado = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^a-z0-9_])${escapado}([^a-z0-9_]|$)`).test(linha)
}

/** A e B se conectam por import (A importa B ou B importa A)? Casa pelo basename sem extensão. */
export function conectadosPorImport(textoA: string, caminhoA: string, textoB: string, caminhoB: string): boolean {
  const baseA = baseSemExt(caminhoA)
  const baseB = baseSemExt(caminhoB)
  return (
    linhasDeImport(textoA).some((l) => citaComoToken(l, baseB)) ||
    linhasDeImport(textoB).some((l) => citaComoToken(l, baseA))
  )
}

export type VereditoAlvo = { ancorado: true } | { ancorado: false; foraDoAlvo: string[] }

/**
 * O diagnóstico que cravou ANCORA no alvo apontado? Sim se cita um arquivo do alvo, ou um arquivo
 * CONECTADO a ele por import (a causa pode legitimamente morar num hook/serviço que o alvo usa, ou
 * no pai que o renderiza — desconectado é que é fuga). Sem arquivo citado, não bloqueia (o gate de
 * hedge já cuidou). `lerTexto` é injetado (testável sem disco); leitura que falha não conecta.
 */
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

/**
 * Resposta honesta quando o diagnóstico cravou FORA do alvo apontado: o alvo parece correto, o
 * achado fica em outro ponto — NÃO edita; lista e pergunta. Pura, testável.
 */
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
