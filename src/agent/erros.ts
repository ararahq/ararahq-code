// Localização de erro a partir da saída de build/teste. A tese da casa aplicada ao conserto: um erro
// de compilação JÁ aponta arquivo:linha exato — é grep grátis. Em vez de deixar o modelo caçar
// semanticamente e mirar o arquivo errado (o caso real: erro "No value passed for parameter
// 'twilioService'" NO TESTE virou edição no TwilioService de produção), extraímos os locais apontados
// pelo compilador e os entregamos como alvos de edição. Determinístico, zero modelo.

const EXTS_FONTE = new Set([
  "kt", "kts", "java", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs",
  "php", "rb", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "cs", "swift", "scala", "groovy",
])

export type LocalErro = { arquivo: string; linha: number }

// Formatos de erro dos compiladores/test runners mais comuns. Todos capturam (arquivo, linha).
const PADROES: RegExp[] = [
  // Kotlin/Java/genérico:  e: file:///a/B.kt:96:13   |   a/B.kt:96:13:   |   a/B.java:12: error:
  /(?:file:\/\/)?(\/?[\w./-]+\.[A-Za-z]+):(\d+)(?::\d+)?/g,
  // TypeScript:  src/a.ts(12,5): error TS2345
  /([\w./-]+\.[A-Za-z]+)\((\d+),\d+\)/g,
  // Rust:  --> src/main.rs:12:9
  /-->\s+([\w./-]+\.[A-Za-z]+):(\d+)/g,
  // Python traceback:  File "a/b.py", line 12
  /File "([^"]+\.[A-Za-z]+)", line (\d+)/g,
]

/**
 * Extrai os locais (arquivo:linha) apontados pela saída de um build/teste que falhou. Só arquivos de
 * código-fonte reais (extensão conhecida), dedup por arquivo:linha, na ordem de aparição (o erro de
 * compilação vem antes de stack trace de runtime), com teto pra não despejar a saída inteira. Puro.
 */
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

/**
 * Dica de conserto ancorada nos locais que o compilador apontou. Vazia se não achou local (aí o
 * modelo diagnostica normal). Injetada no retorno de uma verificação que falhou — é o que impede
 * "erro no teste X" virar "edição no serviço Y de nome parecido".
 */
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
