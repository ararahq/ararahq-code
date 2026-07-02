import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Parseia conteúdo de um .env simples (KEY=VALUE por linha): ignora comentário (#) e linha vazia,
 * corta no PRIMEIRO '=' (valor pode conter '='), tira aspas simples/duplas do valor. Puro/testável.
 */
export function parseEnv(conteudo: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const linhaRaw of conteudo.split("\n")) {
    const linha = linhaRaw.trim()
    if (!linha || linha.startsWith("#")) continue
    const i = linha.indexOf("=")
    if (i <= 0) continue
    const chave = linha.slice(0, i).trim()
    let valor = linha.slice(i + 1).trim()
    if (valor.length >= 2 && ((valor[0] === '"' && valor.at(-1) === '"') || (valor[0] === "'" && valor.at(-1) === "'"))) {
      valor = valor.slice(1, -1)
    }
    if (chave) out[chave] = valor
  }
  return out
}

const CAMINHO_CONFIG_GLOBAL = `${process.env.HOME}/.arara/.env`

/**
 * "Configure uma vez": carrega ~/.arara/.env pro process.env, SEM sobrescrever o que já existe —
 * export do shell e .env do cwd (auto-carregado pelo Bun) têm precedência. É o que faz o comando
 * global `jade-code` achar a chave em qualquer diretório. Best-effort: arquivo ausente/ilegível → no-op.
 */
export function carregarConfigGlobal(caminho = CAMINHO_CONFIG_GLOBAL): void {
  let conteudo: string
  try {
    conteudo = readFileSync(caminho, "utf8")
  } catch {
    return
  }
  for (const [chave, valor] of Object.entries(parseEnv(conteudo))) {
    if (process.env[chave] === undefined) process.env[chave] = valor
  }
}

/**
 * Salva/atualiza UMA variável em ~/.arara/.env, preservando as outras já presentes. Cria o diretório
 * se faltar e grava 0600 (só o dono lê — é segredo). É o "pediu a chave, guardou" do primeiro run.
 */
export function salvarConfigGlobal(chave: string, valor: string, caminho = CAMINHO_CONFIG_GLOBAL): void {
  let atual: Record<string, string> = {}
  try {
    atual = parseEnv(readFileSync(caminho, "utf8"))
  } catch {}
  atual[chave] = valor
  const conteudo = Object.entries(atual)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n"
  mkdirSync(dirname(caminho), { recursive: true })
  writeFileSync(caminho, conteudo, { mode: 0o600 })
}

export interface SaidaChave {
  aviso: (m: string) => void
  subItem: (m: string) => void
  info: (m: string) => void
  sucesso: (m: string) => void
}

const MAX_TENTATIVAS_CHAVE = 3

/**
 * Fluxo "traga a SUA chave": em TTY pede a OPENROUTER_API_KEY, valida o prefixo `sk-` e salva em
 * ~/.arara/.env (configura uma vez). Sem TTY (pipe/CI) só instrui onde pôr e devolve null — nunca trava.
 * Retorna a chave salva, ou null. `perguntar`/`salvar` são injetados → testável sem terminal real.
 */
export async function configurarChave(opts: {
  temTTY: boolean
  perguntar: (p: string) => Promise<string | null>
  ui: SaidaChave
  salvar?: (chave: string, valor: string) => void
}): Promise<string | null> {
  const { temTTY, perguntar, ui } = opts
  const salvar = opts.salvar ?? ((c, v) => salvarConfigGlobal(c, v))
  if (!temTTY) {
    ui.aviso("sem OPENROUTER_API_KEY — configure pra usar os modelos:")
    ui.subItem("global (1x): mkdir -p ~/.arara && echo 'OPENROUTER_API_KEY=sk-or-...' > ~/.arara/.env")
    ui.subItem("ou no shell (~/.zshrc): export OPENROUTER_API_KEY=sk-or-...")
    ui.subItem("pegue a chave em https://openrouter.ai/keys")
    return null
  }
  ui.aviso("Você usa a SUA chave da OpenRouter — fica só na sua máquina, não passa pela gente.")
  ui.subItem("pegue em https://openrouter.ai/keys (você paga só o seu uso)")
  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_CHAVE; tentativa++) {
    const entrada = await perguntar("  cole sua OPENROUTER_API_KEY ▸ ")
    if (entrada === null) {
      ui.info("sem chave por enquanto — configure depois em ~/.arara/.env ou via export.")
      return null
    }
    const chave = entrada.trim()
    if (!chave) continue
    if (!chave.startsWith("sk-")) {
      ui.aviso("não parece uma chave OpenRouter (começa com sk-or-...). cola de novo ou Ctrl+C.")
      continue
    }
    salvar("OPENROUTER_API_KEY", chave)
    ui.sucesso("chave salva em ~/.arara/.env — não precisa repetir.")
    return chave
  }
  ui.info("seguindo sem chave; salve depois em ~/.arara/.env ou via export.")
  return null
}
