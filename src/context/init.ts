import { generateText } from "ai"
import { mkdir, readdir } from "node:fs/promises"
import { dirname } from "node:path"
import { provedor } from "../llm/openrouter"
import { carregarContexto, resetContexto, caminhoCache, temSintese } from "./projeto"
import { ui } from "../terminal/ui"

const MODELO = "deepseek/deepseek-v4-flash"
const MAX_EVID = 14000
const MAX_SUBREADME = 6

const SISTEMA =
  "Você escreve um arquivo de contexto de projeto conciso e útil para um agente de programação, em português brasileiro, sem emojis. " +
  "Estruture em seções curtas: O que é, O que faz, Stack, Estrutura principal, Como rodar/buildar, Convenções. " +
  "Direto ao ponto, baseado SÓ nas evidências. Não invente."

async function evidencias(raiz: string): Promise<string> {
  const ctx = await carregarContexto()
  const partes: string[] = [ctx.completo]
  try {
    const subs = (await readdir(raiz, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
    let n = 0
    for (const s of subs) {
      if (n >= MAX_SUBREADME) break
      const r = Bun.file(`${raiz}/${s}/README.md`)
      if (await r.exists()) {
        partes.push(`### ${s}/README.md\n${(await r.text()).slice(0, 1200)}`)
        n++
      }
    }
  } catch {}
  return partes.join("\n\n").slice(0, MAX_EVID)
}

async function sintetizar(raiz: string): Promise<string> {
  const ev = await evidencias(raiz)
  const openrouter = provedor()
  const { text } = await generateText({
    model: openrouter(MODELO),
    system: SISTEMA,
    prompt: `Evidências do projeto:\n\n${ev}\n\nEscreva o contexto.`,
    temperature: 0.2,
  })
  return `# Contexto do Projeto\n\n_Sintetizado automaticamente pelo Jade Code._\n\n${text.trim()}\n`
}

async function salvarCache(raiz: string, md: string): Promise<void> {
  const destino = caminhoCache(raiz)
  await mkdir(dirname(destino), { recursive: true })
  await Bun.write(destino, md)
}

/** Automático no boot: sintetiza uma vez por projeto, em background, sem travar nada. */
export async function garantirSintese(): Promise<void> {
  const raiz = process.cwd()
  if (await temSintese(raiz)) return
  if (!process.env.OPENROUTER_API_KEY?.trim()) return
  try {
    const md = await sintetizar(raiz)
    await salvarCache(raiz, md)
    resetContexto()
  } catch {}
}

/** Comando /init: força a síntese e materializa o ARARA.md visível no projeto. */
export async function inicializarProjeto(): Promise<void> {
  const raiz = process.cwd()
  ui.passo("Explorando e sintetizando o projeto...")
  try {
    ui.spinnerStart("Sintetizando")
    const md = await sintetizar(raiz)
    ui.spinnerStop()
    await Bun.write(`${raiz}/ARARA.md`, md)
    await salvarCache(raiz, md)
    resetContexto()
    ui.sucesso("ARARA.md criado e cacheado. Vou usar isso a cada sessão.")
  } catch (e) {
    ui.spinnerStop()
    ui.erro(`Falha ao sintetizar: ${(e as Error).message}`)
  }
}
