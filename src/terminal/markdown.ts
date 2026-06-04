const ESC = "\x1b"
const code = (n: number) => (s: string) => `${ESC}[${n}m${s}${ESC}[0m`
const rgb = (r: number, g: number, b: number) => (s: string) => `${ESC}[38;2;${r};${g};${b}m${s}${ESC}[0m`

const bold = code(1)
const italic = code(3)
const underline = code(4)
const brand = rgb(95, 188, 199)
const brandDeep = rgb(28, 153, 167)
const dim = rgb(118, 160, 166)
const txt = rgb(244, 248, 250)

const largura = Math.min(process.stdout.columns || 80, 92)

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_, x) => brandDeep(x))
    .replace(/\*\*([^*]+)\*\*/g, (_, x) => bold(x))
    .replace(/(^|[^*])\*([^*\n]+)\*/g, (_, p, x) => `${p}${italic(x)}`)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, (_, t) => underline(brand(t)))
}

function splitRow(l: string): string[] {
  return l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
}

function renderTable(header: string[], rows: string[][]): string[] {
  const cols = Math.max(header.length, ...rows.map((r) => r.length))
  const w: number[] = []
  for (let c = 0; c < cols; c++) {
    w[c] = Math.max((header[c] ?? "").length, ...rows.map((r) => (r[c] ?? "").length), 1)
  }
  const fileira = (cs: string[], estilo: (s: string) => string) =>
    dim("│ ") + Array.from({ length: cols }, (_, c) => estilo((cs[c] ?? "").padEnd(w[c]))).join(dim(" │ ")) + dim(" │")
  const barra = (e: string, sep: string, f: string) => dim(e + w.map((x) => "─".repeat(x + 2)).join(sep) + f)
  return [barra("┌", "┬", "┐"), fileira(header, bold), barra("├", "┼", "┤"), ...rows.map((r) => fileira(r, txt)), barra("└", "┴", "┘")]
}

export function renderMarkdown(texto: string): string {
  const linhas = texto.replace(/\r/g, "").split("\n")
  const out: string[] = []
  let i = 0
  while (i < linhas.length) {
    const l = linhas[i]

    if (/^\s*```/.test(l)) {
      i++
      const buf: string[] = []
      while (i < linhas.length && !/^\s*```/.test(linhas[i])) {
        buf.push(linhas[i])
        i++
      }
      i++
      for (const b of buf) out.push(dim("  │ ") + txt(b))
      out.push("")
      continue
    }

    if (l.includes("|") && i + 1 < linhas.length && /-/.test(linhas[i + 1]) && /^[\s:|-]+$/.test(linhas[i + 1])) {
      const header = splitRow(l)
      i += 2
      const rows: string[][] = []
      while (i < linhas.length && linhas[i].includes("|") && linhas[i].trim()) {
        rows.push(splitRow(linhas[i]))
        i++
      }
      out.push(...renderTable(header, rows), "")
      continue
    }

    const h = l.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      out.push(brand(bold(inline(h[2]))))
      i++
      continue
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      out.push(dim("─".repeat(Math.min(50, largura))))
      i++
      continue
    }

    const bq = l.match(/^>\s?(.*)$/)
    if (bq) {
      out.push(dim("│ ") + dim(italic(inline(bq[1]))))
      i++
      continue
    }

    const ul = l.match(/^(\s*)[-*+]\s+(.*)$/)
    if (ul) {
      out.push(`${ul[1]}${brand("•")} ${inline(ul[2])}`)
      i++
      continue
    }

    const ol = l.match(/^(\s*)(\d+)\.\s+(.*)$/)
    if (ol) {
      out.push(`${ol[1]}${brand(`${ol[2]}.`)} ${inline(ol[3])}`)
      i++
      continue
    }

    out.push(l.trim() ? inline(l) : "")
    i++
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()
}
