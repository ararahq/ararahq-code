const EXTS_FONTE = new Set([
  "kt", "kts", "java", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs",
  "php", "rb", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "cs", "swift", "scala", "groovy",
])

export type LocalErro = { arquivo: string; linha: number }

const PADROES: RegExp[] = [

  /(?:file:\/\/)?(\/?[\w./-]+\.[A-Za-z]+):(\d+)(?::\d+)?/g,

  /([\w./-]+\.[A-Za-z]+)\((\d+),\d+\)/g,

  /-->\s+([\w./-]+\.[A-Za-z]+):(\d+)/g,

  /File "([^"]+\.[A-Za-z]+)", line (\d+)/g,
]

export function extrairLocaisErro(saida: string, max = 6): LocalErro[] {
  const vistos = new Set<string>()
  const out: LocalErro[] = []
  for (const linha of saida.split("\n")) {
    for (const re of PADROES) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(linha))) {
        const arquivo = m[1].replace(/^file:\/\//, "")
        const ext = arquivo.slice(arquivo.lastIndexOf(".") + 1).toLowerCase()
        if (!EXTS_FONTE.has(ext)) continue
        const n = Number(m[2])
        if (!Number.isInteger(n) || n <= 0) continue
        const chave = `${arquivo}:${n}`
        if (vistos.has(chave)) continue
        vistos.add(chave)
        out.push({ arquivo, linha: n })
        if (out.length >= max) return out
      }
    }
  }
  return out
}

export function dicaLocaisErro(saida: string): string {
  const locais = extrairLocaisErro(saida)
  if (!locais.length) return ""
  const lista = locais.map((l) => `${l.arquivo}:${l.linha}`).join(", ")
  return (
    `\n\n--- O compilador/teste aponta o erro EXATAMENTE em: ${lista}. ` +
    `Abra e conserte NESSES arquivos:linha. NÃO presuma que o problema está em outro arquivo de nome parecido ` +
    `(um erro num arquivo de teste se conserta no próprio teste, não no serviço de produção que ele exercita).`
  )
}
