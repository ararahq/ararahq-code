import { renderMarkdown } from "./markdown"
import { blindarFachada } from "../security/sanitize"

// Paleta ancorada nos tokens da identidade Arara (ararahq-identidade.pen / globals.css).
// brand-400 = teal vivo (primário), brand-500 = teal profundo (moldura/mascote). Não invente tom fora do ramp.
const BRAND = [56, 209, 216] // brand-400 #38d1d8
const BRAND_DEEP = [28, 153, 167] // brand-500 #1c99a7
const TEXT = [244, 248, 250]
const DIM = [118, 160, 166]
const WARN = [247, 185, 85]
const ERR = [255, 90, 95]

const ESC = "\x1b"
const paint = (rgb: number[], s: string) => `${ESC}[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}${ESC}[0m`
const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`
const brand = (s: string) => paint(BRAND, s)
const brandDeep = (s: string) => paint(BRAND_DEEP, s)
const txt = (s: string) => paint(TEXT, s)
const dim = (s: string) => paint(DIM, s)
const warn = (s: string) => paint(WARN, s)
const err = (s: string) => paint(ERR, s)

const LW = 34
const RW = 39
const BOX = LW + RW + 7

const MASCOTE = ["      __", "   __(o )>", "   \\___) )", "    ~~~~~"]
const NOVIDADES = [
  "Jade escolhe a marcha por tarefa",
  "Diagnostico com comparacao pareada",
  "Execucao guiada apos diagnosticar",
]
const CONTA = { nome: "Micael", email: "micael@ararahq.com", org: "AraraHQ" }

async function lerVersao(rel: string, padrao: string): Promise<string> {
  try {
    const t = await Bun.file(new URL(rel, import.meta.url)).text()
    return t.trim() || padrao
  } catch {
    return padrao
  }
}
const VERSAO = await lerVersao("../../jade.version", "0.0.1")
const PRODUTO = await (async () => {
  try {
    const pkg = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as { version?: string }
    return pkg.version ?? "0.0.1"
  } catch {
    return "0.0.1"
  }
})()

type Estilo = "mascote" | "brand" | "brandBold" | "text" | "dim"
type Cel = { texto: string; estilo: Estilo }

function colir(s: string, e: Estilo): string {
  switch (e) {
    case "mascote": return brandDeep(s)
    case "brand": return brand(s)
    case "brandBold": return brand(bold(s))
    case "dim": return dim(s)
    default: return txt(s)
  }
}
function pad(s: string, w: number): string {
  const t = s.length > w ? s.slice(0, w) : s
  return t + " ".repeat(w - t.length)
}
function abreviar(p: string): string {
  const home = process.env.HOME ?? ""
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p
}
function topo(t: string): string {
  return brandDeep("┌─ ") + brand(bold(t)) + brandDeep(" " + "─".repeat(Math.max(0, BOX - 5 - t.length)) + "┐")
}
function base(): string {
  return brandDeep("└" + "─".repeat(BOX - 2) + "┘")
}
function vazia(): string {
  return brandDeep("│ ") + " ".repeat(LW) + brandDeep(" │ ") + " ".repeat(RW) + brandDeep(" │")
}
function linhaDupla(e: Cel | undefined, d: Cel | undefined): string {
  const ec = colir(pad(e?.texto ?? "", LW), e?.estilo ?? "text")
  const dc = colir(pad(d?.texto ?? "", RW), d?.estilo ?? "text")
  return brandDeep("│ ") + ec + brandDeep(" │ ") + dc + brandDeep(" │")
}

async function* gerarLinhas(): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, idx).replace(/\r$/, "")
      buffer = buffer.slice(idx + 1)
    }
  }
  if (buffer.length > 0) yield buffer
}
const iterLinhas = gerarLinhas()
async function lerLinha(prompt: string): Promise<string | null> {
  if (_headless) return null
  revelarCursor()
  process.stdout.write(prompt)
  const r = await iterLinhas.next()
  return r.done ? null : r.value
}

// Modo headless (sandbox/CI): NUNCA lê stdin — num container sem TTY, esperar input trava pra
// sempre. prompt/perguntar devolvem null e confirmar() NEGA: comando perigoso não roda sem humano.
let _headless = false
export function ativarHeadless(): void {
  _headless = true
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
let cursorOculto = false
function ocultarCursor() {
  if (process.stdout.isTTY && !cursorOculto) {
    process.stdout.write("\x1b[?25l")
    cursorOculto = true
  }
}
function revelarCursor() {
  if (cursorOculto) {
    process.stdout.write("\x1b[?25h")
    cursorOculto = false
  }
}
// Garantia anti-idiota: nunca deixar o cursor escondido, aconteça o que acontecer.
process.on("exit", revelarCursor)
let spinnerTimer: ReturnType<typeof setInterval> | null = null
function spinnerStartRaw(label: string) {
  if (!process.stdout.isTTY || spinnerTimer) return
  ocultarCursor()
  let i = 0
  const inicio = Date.now()
  spinnerTimer = setInterval(() => {
    const s = Math.floor((Date.now() - inicio) / 1000)
    const tempo = s > 0 ? dim(` ${s}s`) : ""
    process.stdout.write(`\r${brand(FRAMES[i++ % FRAMES.length])} ${dim(label)}${tempo}  `)
  }, 80)
}
function spinnerStopRaw() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer)
    spinnerTimer = null
    process.stdout.write(`\r${" ".repeat(48)}\r`)
  }
  revelarCursor()
}

let streamLinhas = 0
let segBuffer = ""
let ultimoRender = 0
function contarLinhas(rendered: string): number {
  const w = process.stdout.columns || 80
  let n = 0
  for (const linha of rendered.split("\n")) {
    const vis = linha.replace(/\x1b\[[0-9;]*m/g, "").length
    n += Math.max(1, Math.ceil(vis / w))
  }
  return n
}
function desenharStream() {
  const rendered = renderMarkdown(blindarFachada(segBuffer))
  if (streamLinhas > 0) process.stdout.write(`\x1b[${streamLinhas}A\x1b[0J`)
  process.stdout.write(`${rendered}\n`)
  streamLinhas = contarLinhas(rendered)
}
function streamAppendRaw(delta: string) {
  spinnerStopRaw()
  segBuffer += delta
  const agora = Date.now()
  if (agora - ultimoRender > 50) {
    desenharStream()
    ultimoRender = agora
  }
}
function streamCommitRaw() {
  spinnerStopRaw()
  if (segBuffer) desenharStream()
  segBuffer = ""
  streamLinhas = 0
  ultimoRender = 0
}

export const ui = {
  renderHeader() {
    const esq: Cel[] = [
      ...MASCOTE.map((m): Cel => ({ texto: m, estilo: "mascote" })),
      { texto: "", estilo: "text" },
      { texto: `Bem-vindo de volta, ${CONTA.nome}!`, estilo: "brandBold" },
      { texto: "", estilo: "text" },
      { texto: `modelo Jade v${VERSAO} · roteamento`, estilo: "brand" },
      { texto: "uma inteligência, várias marchas", estilo: "dim" },
      { texto: `${CONTA.email} · ${CONTA.org}`, estilo: "dim" },
      { texto: abreviar(process.cwd()), estilo: "dim" },
    ]
    const dir: Cel[] = [
      { texto: "Dicas pra comecar", estilo: "brandBold" },
      { texto: "Digite uma tarefa ou /ajuda", estilo: "dim" },
      { texto: "Simples roda rapido e barato", estilo: "dim" },
      { texto: "", estilo: "text" },
      { texto: "Novidades", estilo: "brandBold" },
      ...NOVIDADES.map((n): Cel => ({ texto: n, estilo: "dim" })),
    ]
    const out = [dim("jade-code"), topo(`Jade Code v${PRODUTO}`), vazia()]
    for (let i = 0; i < Math.max(esq.length, dir.length); i++) out.push(linhaDupla(esq[i], dir[i]))
    out.push(vazia(), base(), "")
    process.stdout.write(out.join("\n") + "\n")
  },
  prompt: (): Promise<string | null> => lerLinha(brand("▸ ")),
  perguntar: (p: string): Promise<string | null> => lerLinha(p),
  async confirmar(p: string): Promise<boolean> {
    if (_headless) {
      console.log(warn(`⚠ headless: negado automaticamente — ${p}`))
      return false
    }
    const r = (await lerLinha(warn(`  ${p} [s/n] `))) ?? ""
    const v = r.trim().toLowerCase()
    return v === "s" || v === "sim" || v === "y"
  },
  passo: (m: string) => console.log(brand("⠿ ") + dim(m)),
  // Fachada Jade: o usuário vê SÓ "Jade · <modo>". Nunca o modelo, o thinking, ou a marcha.
  // A inteligência (qual marcha rodou) é a propriedade intelectual — não vaza pra tela.
  jade: (modo: string) => console.log(`${brand("◆")} ${brand("Jade")} ${dim("· " + modo)}`),
  subItem: (m: string) => console.log(`  ${brand("→")} ${dim(m)}`),
  info: (m: string) => console.log(txt(m)),
  linhaBranca: () => console.log(),
  spinnerStart: (label: string) => spinnerStartRaw(label),
  spinnerStop: () => spinnerStopRaw(),
  resposta: (texto: string) => console.log(renderMarkdown(blindarFachada(texto))),
  streamAppend: (delta: string) => streamAppendRaw(delta),
  streamCommit: () => streamCommitRaw(),
  sucesso: (m: string) => console.log(`${brand("✓")} ${m}`),
  erro: (m: string) => console.log(`${err("✗")} ${m}`),
  aviso: (m: string) => console.log(`${warn("⚠")} ${m}`),
  toolAcao: (n: string, d: string) => {
    streamCommitRaw()
    spinnerStopRaw()
    console.log(`${brand("●")} ${dim(d ? `${n}  ${d}` : n)}`)
  },
  toolResultado: (texto: string) => {
    spinnerStopRaw()
    console.log(`  ${dim(texto)}`)
  },
  motivo: (m: string) => console.log(`  ${dim("motivo:")} ${txt(m)}`),
  linhaComando: (l: string) => console.log(dim(`  │ ${l}`)),
  plano: (passos: string[]) => {
    streamCommitRaw()
    spinnerStopRaw()
    console.log(brand(bold("  Plano")))
    passos.forEach((p, i) => console.log(`  ${brand(`${i + 1}.`)} ${txt(p)}`))
    console.log()
  },
  passoConcluido: (texto: string) => {
    streamCommitRaw()
    spinnerStopRaw()
    console.log(`  ${brand("✓")} ${dim(texto)}`)
  },
  diff(removido: string, adicionado: string) {
    const rem = removido.trim() ? removido.split("\n") : []
    const add = adicionado.split("\n")
    rem.slice(0, 40).forEach((l) => console.log(err(`  - ${l}`)))
    add.slice(0, 40).forEach((l) => console.log(brand(`  + ${l}`)))
  },
  // Fachada Jade: tokens/custo/tempo OK; modelo e "thinking" NÃO aparecem (são internos).
  metricas(tokens: number, custo: number, ms: number) {
    const tk = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`
    console.log(`${brand("✓")} ${dim(`pronto · ${tk} tokens · $${custo.toFixed(4)} · ${(ms / 1000).toFixed(1)}s`)}`)
    console.log()
  },
  custo(sessao: { tarefas: number; tokens: number; custoUSD: number }, mes: { tarefas: number; tokens: number; custoUSD: number }, rotuloMes: string) {
    const fmt = (a: { tarefas: number; tokens: number; custoUSD: number }) => {
      const tk = a.tokens >= 1000 ? `${(a.tokens / 1000).toFixed(1)}k` : `${a.tokens}`
      return `${a.tarefas} tarefa(s) · ${tk} tokens · $${a.custoUSD.toFixed(4)}`
    }
    console.log(brand(bold("  Custo")))
    console.log(`  ${brand("sessão")} ${dim(fmt(sessao))}`)
    console.log(`  ${brand(rotuloMes)} ${dim(fmt(mes))}`)
    console.log()
  },
  // Painel ADMIN interno (D10): revela a marcha e o MODELO REAL por tarefa. Só aqui, no /custo —
  // nunca na resposta normal (essa é a fachada Jade). É o canal de auditoria de qual marcha rodou.
  custoHistorico(linhas: { modo: string; modelo: string; tokens: number; custoUSD: number; ms: number }[]) {
    if (!linhas.length) return
    console.log(brand(bold("  Marchas (admin · modelo real)")))
    for (const l of linhas) {
      const tk = l.tokens >= 1000 ? `${(l.tokens / 1000).toFixed(1)}k` : `${l.tokens}`
      console.log(
        `  ${dim(l.modo.padEnd(11))} ${txt(l.modelo)} ${dim(`· ${tk} tok · $${l.custoUSD.toFixed(4)} · ${(l.ms / 1000).toFixed(1)}s`)}`,
      )
    }
    console.log()
  },
  fechar: () => revelarCursor(),
}
