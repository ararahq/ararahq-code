import { generateObject } from "ai"
import { z } from "zod"

export const MAX_SUBOBJETIVOS = 10

export type SubObjetivo = {
  descricao: string
  arquivosAlvo: string[]
  tipo: "execucao" | "diagnostico"
}

export type Plano = {
  resumo: string
  subobjetivos: SubObjetivo[]
}

type ModeloLLM = Parameters<typeof generateObject>[0]["model"]

const PlanoSchema = z.object({
  resumo: z.string().describe("uma frase: o que a tarefa inteira entrega quando pronta"),
  subobjetivos: z
    .array(
      z.object({
        descricao: z.string().describe("UMA mudança lógica, concreta e verificável (compila/roda sozinha)"),
        arquivosAlvo: z.array(z.string()).describe("arquivos/caminhos que este passo provavelmente toca; vazio se ainda não dá pra saber"),
        tipo: z.enum(["execucao", "diagnostico"]).describe("execucao se a mudança já é clara; diagnostico se precisa achar a causa primeiro"),
      }),
    )
    .min(1)
    .max(MAX_SUBOBJETIVOS),
})

const SISTEMA_DECOMPOR =
  "Você decompõe uma tarefa de engenharia em sub-objetivos ORDENADOS. Cada sub-objetivo é UMA mudança " +
  "lógica única e verificável — do tamanho de uma correção/edição focada que compila sozinha. Respeite " +
  "dependências: o que precisa existir antes vem antes. Se a tarefa inteira é uma mudança só, devolva UM " +
  "sub-objetivo. Se é grande, quebre em quantos forem necessários (até o limite). Cite arquivos quando souber. " +
  "Não invente passos de teste/documentação que o usuário não pediu."

export type ResultadoDecompor = { plano: Plano; inTok: number; outTok: number }

export async function decompor(input: string, model: ModeloLLM): Promise<ResultadoDecompor | null> {
  try {
    const r = await generateObject({
      model,
      schema: PlanoSchema,
      system: SISTEMA_DECOMPOR,
      prompt: input,
      temperature: 0.2,
    })
    const u = r.usage as { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number }
    return {
      plano: r.object as Plano,
      inTok: u?.inputTokens ?? u?.promptTokens ?? 0,
      outTok: u?.outputTokens ?? u?.completionTokens ?? 0,
    }
  } catch {
    return null
  }
}

export function valeOrquestrar(plano: Plano | null): boolean {
  return !!plano && plano.subobjetivos.length > 1
}

export function promptDoSub(plano: Plano, indice: number): string {
  const sub = plano.subobjetivos[indice]
  const total = plano.subobjetivos.length
  const alvo = sub.arquivosAlvo.length ? ` Arquivos prováveis: ${sub.arquivosAlvo.join(", ")}.` : ""
  return (
    `TAREFA GERAL: ${plano.resumo}\n\n` +
    `SUB-OBJETIVO ${indice + 1}/${total}: ${sub.descricao}.${alvo}\n` +
    `Faça SOMENTE este sub-objetivo agora: edite o necessário e pare. NÃO adiante os outros sub-objetivos. ` +
    `NÃO repita estas instruções na resposta — só aja.`
  )
}

export type EstadoSub = "verde" | "sem-gate" | "travou"
export type SubFeito = { descricao: string; estado: EstadoSub }

export function relatorioProgresso(
  plano: Plano,
  feitos: SubFeito[],
  travouEm: number | null,
  motivo: string,
): string {
  const linhas = feitos.map((f, i) => `  ${i + 1}. ${f.estado === "verde" ? "[verde]" : "[ok]"} ${f.descricao}`)
  const partes = [`[Jade] "${plano.resumo}" — ${feitos.length}/${plano.subobjetivos.length} sub-objetivos:`]
  partes.push(linhas.join("\n"))
  if (travouEm !== null) {
    const sub = plano.subobjetivos[travouEm]
    partes.push(`  ${travouEm + 1}. [travou] ${sub.descricao} — ${motivo}`)
    const restantes = plano.subobjetivos.slice(travouEm + 1)
    if (restantes.length) {
      partes.push(`  Falta: ${restantes.map((s) => s.descricao).join("; ")}.`)
    }
    partes.push("Não segui no escuro — me diz como destravar o passo acima que eu continuo de onde parei.")
  }
  return partes.join("\n")
}
