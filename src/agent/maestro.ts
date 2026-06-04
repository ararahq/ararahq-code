import { generateObject } from "ai"
import { z } from "zod"

// Maestro — orquestração de tarefas COMPLEXAS. A tese: o agente já é forte em problema MÉDIO
// (diagnosticar + corrigir + verificar UM ponto). Problema complexo NÃO é um problema maior — é uma
// SEQUÊNCIA de problemas médios. Em vez de um loop gigante (que a trava de trajetória aborta aos 16
// passos), o Maestro DECOMPÕE em sub-objetivos verificáveis e roda cada um na máquina já provada,
// com portão de build e CHECKPOINT entre eles. Cada sub-objetivo é uma chamada de execução nova =
// orçamento de passos próprio, então o teto global deixa de ser o limite. Tarefa simples gera UM
// sub-objetivo e passa direto, sem overhead. O modelo só é forte UMA vez (o plano); a execução é barata.

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

/**
 * Decompõe a tarefa num plano de sub-objetivos via UMA passada de raciocínio (modelo forte, saída
 * estruturada). Determinístico de formato (schema), não de conteúdo. Devolve null se a decomposição
 * falhar (modelo sem suporte a saída estruturada, erro de rede) — quem chama degrada pro caminho normal.
 */
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

/** A tarefa é mesmo complexa (vale orquestrar)? Só quando a decomposição rende mais de um passo. */
export function valeOrquestrar(plano: Plano | null): boolean {
  return !!plano && plano.subobjetivos.length > 1
}

/** Instrução de UM sub-objetivo pra execução guiada (injetada como mensagem da passada, não no histórico). */
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

// --- Checkpoint + relatório honesto ------------------------------------------

export type EstadoSub = "verde" | "sem-gate" | "travou"
export type SubFeito = { descricao: string; estado: EstadoSub }

/**
 * Relatório de progresso quando a orquestração fecha ou trava. Lista o que JÁ ficou pronto (com o
 * estado do build de cada um) e, se travou, ONDE e por quê — com o que ainda falta. Nunca some com o
 * progresso: complexo que para na metade tem que devolver o mapa do que foi feito.
 */
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
