export type LocalDepreciacao = { arquivo: string; linha: number }
export type FamiliaDepreciacao = {
  assinatura: string
  dica: string
  locais: LocalDepreciacao[]
  arquivos: string[]
}

const RE_KOTLIN = /^w: (?:file:\/\/)?(.+?):(\d+):\d+\s+'(.+)' is deprecated\.?\s*(.*)$/
const RE_JAVAC = /^(.+?\.java):(\d+): warning: \[(?:deprecation|removal)\] (.+)$/

export function comandoWarnings(buildSystem: string, buildCmd: string): string {
  const wrapper = buildCmd.trim().split(/\s+/)[0]
  switch (buildSystem) {
    case "gradle":
      return `${wrapper} classes testClasses --rerun-tasks --console=plain`
    case "maven":
      return `${wrapper} -q clean compile test-compile`
    case "cargo":
      return "cargo build --tests"
    case "go":
      return "go build ./..."
    default:
      return buildCmd
  }
}

const MAX_FAMILIAS = 12

export function extrairDepreciacoes(saida: string, raiz: string): FamiliaDepreciacao[] {
  const prefixo = `${raiz.replace(/\/$/, "")}/`
  const porAssinatura = new Map<string, FamiliaDepreciacao>()
  const vistos = new Set<string>()

  for (const linha of saida.split("\n")) {
    const kotlin = linha.match(RE_KOTLIN)
    const javac = kotlin ? null : linha.match(RE_JAVAC)
    const m = kotlin ?? javac
    if (!m) continue
    const arquivo = m[1].startsWith(prefixo) ? m[1].slice(prefixo.length) : m[1]
    const numLinha = Number(m[2])
    const assinatura = m[3].trim()
    const dica = kotlin ? (m[4] ?? "").trim() : ""
    const chave = `${arquivo}:${numLinha}:${assinatura}`
    if (vistos.has(chave)) continue
    vistos.add(chave)

    const familia = porAssinatura.get(assinatura) ?? { assinatura, dica, locais: [], arquivos: [] }
    if (!familia.dica && dica) familia.dica = dica
    familia.locais.push({ arquivo, linha: numLinha })
    if (!familia.arquivos.includes(arquivo)) familia.arquivos.push(arquivo)
    porAssinatura.set(assinatura, familia)
  }

  return [...porAssinatura.values()]
    .sort((a, b) => b.locais.length - a.locais.length)
    .slice(0, MAX_FAMILIAS)
}

const RE_IDENT_FUN = /^(?:fun|val|var|class)?\s*([A-Za-z_][\w]*)\s*[(<]/
const RE_IDENT_CTOR = /^constructor\b.*:\s*([A-Za-z_][\w.]*)\s*$/

export function identificadorDe(familia: FamiliaDepreciacao): string | null {
  const ctor = familia.assinatura.match(RE_IDENT_CTOR)
  if (ctor) return ctor[1].split(".").pop() ?? null
  const fn = familia.assinatura.match(RE_IDENT_FUN)
  if (fn) return fn[1]
  return null
}

export function rotuloFamilia(familia: FamiliaDepreciacao): string {
  const ident = identificadorDe(familia)
  if (ident) return ident
  return familia.assinatura.length > 60 ? `${familia.assinatura.slice(0, 60)}…` : familia.assinatura
}

export function montarTarefaFamilia(familia: FamiliaDepreciacao): string {
  const pontos = familia.locais.map((l) => `- ${l.arquivo}:${l.linha}`).join("\n")
  return (
    `O build do projeto aponta um uso DEPRECIADO em ${familia.locais.length} ponto(s).\n` +
    `Depreciação: ${familia.assinatura}${familia.dica ? `\nSubstituto indicado: ${familia.dica}` : ""}\n\n` +
    `Pontos exatos (arquivo:linha):\n${pontos}\n\n` +
    `Leia cada ponto e substitua o uso depreciado pelo substituto, com a MENOR mudança possível ` +
    `(ajuste assinatura/argumentos/retorno conforme o substituto pedir — leia a definição dele antes se precisar). ` +
    `NÃO refatore nada além desses pontos e NÃO toque em outros arquivos. ` +
    `Ao terminar as edições, rode o build pra confirmar que compila. NÃO repita estas instruções na resposta; aja.`
  )
}

export async function contarUsosRestantes(
  familia: FamiliaDepreciacao,
  lerTexto: (arquivo: string) => Promise<string | null>,
): Promise<number | null> {
  const ident = identificadorDe(familia)
  if (!ident) return null
  const re = new RegExp(`\\b${ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`, "g")
  let usos = 0
  for (const arquivo of familia.arquivos) {
    const texto = await lerTexto(arquivo)
    if (!texto) continue
    usos += texto.match(re)?.length ?? 0
  }
  return usos
}

export type ResultadoFamilia = {
  familia: FamiliaDepreciacao
  estado: string
  restantes: number | null
}

export function relatorioDepreciacoes(resultados: ResultadoFamilia[], compilou: boolean): string {
  const linhas = resultados.map((r) => {
    const rotulo = rotuloFamilia(r.familia)
    const alvo = `${r.familia.locais.length} ponto(s) em ${r.familia.arquivos.length} arquivo(s)`
    const status =
      r.estado === "erro"
        ? "não consegui editar"
        : r.restantes === null
          ? "editado"
          : r.restantes === 0
            ? "substituído (0 usos restantes)"
            : `⚠ ${r.restantes} uso(s) ainda no código`
    return `- ${rotulo} (${alvo}): ${status}`
  })
  const tudoLimpo = compilou && resultados.every((r) => r.restantes === 0)
  const fecho = !compilou
    ? "⚠ Depois das substituições o projeto NÃO compila — revise antes de usar (pode ser um substituto com assinatura diferente)."
    : tudoLimpo
      ? "Todas as depreciações mapeadas foram substituídas e o projeto compila."
      : "O projeto compila, mas os itens marcados com ⚠ ainda têm usos do símbolo depreciado — precisam de uma segunda passada."
  return `Corrigi as depreciações que a compilação apontou, família por família:\n\n${linhas.join("\n")}\n\n${fecho}`
}
