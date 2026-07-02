import { generateText } from "ai"
import { provedor } from "../llm/openrouter"

export type Fase = "ler" | "editar" | "verificar" | "geral"
export type Passo = { texto: string; fase: Fase }

const MODELO_PLANO = "deepseek/deepseek-v4-flash"
const SISTEMA_PLANO =
  "Você decompõe uma tarefa de programação em passos atômicos e ordenados. " +
  "Responda APENAS com um array JSON de strings curtas, em português, na ordem de execução. " +
  "Cada item é uma ação única e concreta (ex: 'ler a entidade X', 'corrigir o método Y', 'rodar o build'). " +
  "A ordem natural é investigar antes de editar, e editar antes de verificar. " +
  "Entre 2 e 6 passos. Nada de texto fora do JSON."

const RE_VERIFICAR = /\b(roda|rode|executa|build|compila|test|gradlew|mvn|npm|bun|cargo|lint|valida)/i
const RE_EDITAR = /\b(corrig|conserta|aplica|ajusta|implementa|escrev|edita|muda|altera|refatora|adiciona|cria|remov|deleta|renomeia|atualiza)/i
const RE_LER = /\b(l[êe]|leia|ler|entend|investig|analis|rastrei|identific|examin|busc|procur|encontr|localiz|confirm|revis|verifi[qc])/i

export function faseDe(texto: string): Fase {
  const s = texto.toLowerCase()
  if (RE_VERIFICAR.test(s)) return "verificar"
  if (RE_EDITAR.test(s)) return "editar"
  if (RE_LER.test(s)) return "ler"
  return "geral"
}

const LER_TOOLS = ["ler_arquivo", "listar_arquivos", "buscar_no_projeto"]

export function ferramentasDaFase(fase: Fase): string[] {
  switch (fase) {
    case "ler":
      return LER_TOOLS
    case "editar":
      return [...LER_TOOLS, "editar_arquivo"]
    default:
      return [...LER_TOOLS, "editar_arquivo", "rodar_comando"]
  }
}

const MARCADORES = /\b(depois|em seguida|ent[ãa]o|por fim|primeiro|segundo|terceiro)\b|->|→|\d\s*[.)]/i
const VERBOS =
  /\b(l[êe]|leia|corrig|conserta|implementa|cria|adiciona|refatora|roda|rode|executa|build|compila|test|edita|escrev|ajusta|aplica|valida|verifi|move|renomeia)/gi

export function pareceMultiPasso(input: string): boolean {
  const s = input.toLowerCase()
  if (MARCADORES.test(s)) return true
  const m = s.match(VERBOS)
  return m ? new Set(m.map((v) => v.slice(0, 4))).size >= 2 : false
}

const SINAIS_LOOP_LONGO =
  /\b(todos os|todas as|cada (arquivo|m[óo]dulo|service|controller|endpoint)|o projeto inteiro|toda a base|migra(r|c|ç)|reescrev|do zero|v[áa]rios arquivos|em massa|todo o c[óo]digo)\b/i
const MIN_VERBOS_LOOP_LONGO = 4

export function pareceLoopLongo(input: string): boolean {
  const s = input.toLowerCase()
  if (SINAIS_LOOP_LONGO.test(s)) return true
  const m = s.match(VERBOS)
  return m ? new Set(m.map((v) => v.slice(0, 4))).size >= MIN_VERBOS_LOOP_LONGO : false
}

export function planoDiagnostico(): Passo[] {
  return [
    { texto: "Os pontos já foram mapeados (seção TRECHOS RELEVANTES do contexto). NÃO use buscar_no_projeto — abra e leia direto os arquivos dos pontos mais relevantes.", fase: "ler" },
    { texto: "Ler cada ponto relevante — não assumir o conteúdo", fase: "ler" },
    { texto: "Comparar os caminhos que deveriam se comportar igual", fase: "ler" },
    { texto: "Declarar a hipótese de causa raiz com evidência (arquivo:linha)", fase: "ler" },
    { texto: "Verificar a hipótese relendo o código", fase: "ler" },
    { texto: "Corrigir a causa raiz", fase: "editar" },
  ]
}

function parsePlano(texto: string): Passo[] {
  const m = texto.match(/\[[\s\S]*\]/)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0]) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .slice(0, 6)
      .map((s) => ({ texto: s.trim(), fase: faseDe(s) }))
  } catch {
    return []
  }
}

export async function planejar(input: string): Promise<Passo[]> {
  try {
    const openrouter = provedor()
    const { text } = await generateText({
      model: openrouter(MODELO_PLANO),
      system: SISTEMA_PLANO,
      prompt: input,
      temperature: 0,
    })
    const passos = parsePlano(text)
    return passos.length >= 2 ? passos : []
  } catch {
    return []
  }
}
