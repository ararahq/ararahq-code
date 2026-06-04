export type TipoSimbolo =
  | "classe" | "interface" | "funcao" | "metodo" | "tipo" | "constante" | "enum" | "struct" | "trait"

export type Simbolo = {
  nome: string
  tipo: TipoSimbolo
  arquivo: string
  linhaInicio: number
  linhaFim: number
  assinatura: string
  herda: string[]
  chama: string[]
  usaTipo: string[]
}

export type Import = { alvo: string; nomes: string[]; linha: number }

export type ArquivoSimbolos = {
  arquivo: string
  linguagem: string
  simbolos: Simbolo[]
  imports: Import[]
}

type Regra = { tipo: TipoSimbolo; re: RegExp; grupo: number }
type Spec = { defs: Regra[]; imports: RegExp[]; chaves: boolean }

const NAO_SIMBOLO = new Set([
  "if", "for", "while", "when", "switch", "catch", "return", "with", "synchronized",
  "else", "do", "try", "finally", "in", "is", "as", "by", "where",
])

const RE_IMPORT_KT = /^\s*import\s+([\w.]+(?:\.\*)?)/
const RE_IMPORT_PY = /^\s*(?:from\s+([\w.]+)\s+import\s+(.+)|import\s+(.+))/
const RE_IMPORT_GO = /^\s*(?:import\s+)?(?:[\w.]+\s+)?"([^"]+)"/
const RE_IMPORT_TS = /^\s*import\s+(?:type\s+)?(?:.+?\s+from\s+)?["']([^"']+)["']/
const RE_IMPORT_RS = /^\s*use\s+([\w:]+)/
const RE_IMPORT_PHP = /^\s*use\s+([\w\\]+)/
const RE_REQUIRE_JS = /\brequire\(\s*["']([^"']+)["']\s*\)/

const JVM: Spec = {
  chaves: true,
  defs: [
    { tipo: "interface", re: /^\s*(?:public|private|protected|internal|open|sealed|abstract|final|static)*\s*interface\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "enum", re: /^\s*(?:public|private|protected|internal)*\s*enum\s+(?:class\s+)?([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "classe", re: /^\s*(?:public|private|protected|internal|open|sealed|abstract|final|static|data|inner|value)*\s*class\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "classe", re: /^\s*(?:public|private|protected|internal)*\s*object\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "metodo", re: /^\s*(?:public|private|protected|internal|open|override|suspend|abstract|final|static|inline|operator|tailrec)*\s*fun\s+(?:<[^>]*>\s*)?(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*)\s*\(/, grupo: 1 },
    { tipo: "tipo", re: /^\s*(?:public|private|internal)*\s*typealias\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "constante", re: /^\s*(?:public|private|internal|const|companion)*\s*(?:val|var)\s+([A-Z][A-Z0-9_]+)\b/, grupo: 1 },
  ],
  imports: [RE_IMPORT_KT],
}

const JAVA: Spec = {
  chaves: true,
  defs: [
    { tipo: "interface", re: /^\s*(?:public|private|protected|abstract|final|static)*\s*interface\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "enum", re: /^\s*(?:public|private|protected)*\s*enum\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "classe", re: /^\s*(?:public|private|protected|abstract|final|static)*\s*class\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "metodo", re: /^\s*(?:public|private|protected|static|final|synchronized|abstract|default)+\s+(?:<[^>]*>\s*)?[\w<>\[\].,?\s]+?\s+([A-Za-z_]\w*)\s*\([^;]*$/, grupo: 1 },
  ],
  imports: [/^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)/],
}

const TS: Spec = {
  chaves: true,
  defs: [
    { tipo: "interface", re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, grupo: 1 },
    { tipo: "enum", re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, grupo: 1 },
    { tipo: "tipo", re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/, grupo: 1 },
    { tipo: "classe", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, grupo: 1 },
    { tipo: "funcao", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/, grupo: 1 },
    { tipo: "funcao", re: /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, grupo: 1 },
    { tipo: "constante", re: /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]+)\b/, grupo: 1 },
  ],
  imports: [RE_IMPORT_TS, RE_REQUIRE_JS],
}

const PY: Spec = {
  chaves: false,
  defs: [
    { tipo: "classe", re: /^\s*class\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "funcao", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, grupo: 1 },
  ],
  imports: [RE_IMPORT_PY],
}

const GO: Spec = {
  chaves: true,
  defs: [
    { tipo: "funcao", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[(<]/, grupo: 1 },
    { tipo: "struct", re: /^\s*type\s+([A-Za-z_]\w*)\s+struct\b/, grupo: 1 },
    { tipo: "interface", re: /^\s*type\s+([A-Za-z_]\w*)\s+interface\b/, grupo: 1 },
    { tipo: "tipo", re: /^\s*type\s+([A-Za-z_]\w*)\s+\w/, grupo: 1 },
  ],
  imports: [RE_IMPORT_GO],
}

const RUST: Spec = {
  chaves: true,
  defs: [
    { tipo: "funcao", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "struct", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "enum", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "trait", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "tipo", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, grupo: 1 },
  ],
  imports: [RE_IMPORT_RS],
}

const PHP: Spec = {
  chaves: true,
  defs: [
    { tipo: "interface", re: /^\s*interface\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "trait", re: /^\s*trait\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "classe", re: /^\s*(?:abstract\s+|final\s+)*class\s+([A-Za-z_]\w*)/, grupo: 1 },
    { tipo: "metodo", re: /^\s*(?:public|private|protected|static|abstract|final)*\s*function\s+([A-Za-z_]\w*)\s*\(/, grupo: 1 },
  ],
  imports: [RE_IMPORT_PHP],
}

const RUBY: Spec = {
  chaves: false,
  defs: [
    { tipo: "classe", re: /^\s*class\s+([A-Z]\w*)/, grupo: 1 },
    { tipo: "metodo", re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, grupo: 1 },
  ],
  imports: [/^\s*require(?:_relative)?\s+["']([^"']+)["']/],
}

const POR_EXT: Record<string, { spec: Spec; lang: string }> = {
  kt: { spec: JVM, lang: "Kotlin" }, kts: { spec: JVM, lang: "Kotlin" },
  java: { spec: JAVA, lang: "Java" },
  ts: { spec: TS, lang: "TypeScript" }, tsx: { spec: TS, lang: "TypeScript" },
  js: { spec: TS, lang: "JavaScript" }, jsx: { spec: TS, lang: "JavaScript" },
  mjs: { spec: TS, lang: "JavaScript" }, cjs: { spec: TS, lang: "JavaScript" },
  py: { spec: PY, lang: "Python" },
  go: { spec: GO, lang: "Go" },
  rs: { spec: RUST, lang: "Rust" },
  php: { spec: PHP, lang: "PHP" },
  rb: { spec: RUBY, lang: "Ruby" },
}

function extOf(arquivo: string): string {
  const i = arquivo.lastIndexOf(".")
  return i < 0 ? "" : arquivo.slice(i + 1).toLowerCase()
}

function indent(linha: string): number {
  const m = linha.match(/^[ \t]*/)
  return m ? m[0].replace(/\t/g, "  ").length : 0
}

const MAX_ASSINATURA = 200

function assinaturaDe(linhas: string[], idx: number): string {
  let s = linhas[idx].trim()
  // Assinatura pode quebrar linha: junta até fechar parêntese ou achar corpo/`=`.
  let bal = (s.match(/\(/g)?.length ?? 0) - (s.match(/\)/g)?.length ?? 0)
  let i = idx
  while (bal > 0 && i + 1 < linhas.length && i - idx < 6) {
    i++
    const prox = linhas[i].trim()
    s += ` ${prox}`
    bal += (prox.match(/\(/g)?.length ?? 0) - (prox.match(/\)/g)?.length ?? 0)
  }
  s = s.replace(/\s*\{\s*$/, "").trim()
  return s.length > MAX_ASSINATURA ? `${s.slice(0, MAX_ASSINATURA)}…` : s
}

/** Fim de um símbolo em linguagem de chaves: fecha pelo balanceamento de `{}` a partir da definição. */
function fimPorChaves(linhas: string[], inicio: number, limite: number): number {
  let bal = 0
  let abriu = false
  for (let i = inicio; i < limite; i++) {
    const linha = semStringsEComentarios(linhas[i])
    for (const ch of linha) {
      if (ch === "{") {
        bal++
        abriu = true
      } else if (ch === "}") {
        bal--
        if (abriu && bal <= 0) return i + 1
      }
    }
  }
  return limite
}

/** Remove conteúdo de strings/comentários de linha pra não contar `{`/`}` literais no balanceamento. */
function semStringsEComentarios(linha: string): string {
  return linha
    .replace(/\\./g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/\/\/.*$/, "")
    .replace(/#.*$/, "")
}

const MAX_LINHAS_STATEMENT = 30

/**
 * Fim de um símbolo que é statement único (constante, typealias): fecha quando todos os delimitadores
 * `()[]{}` abertos na declaração se balanceiam. Evita que uma `const X = /regex/` "absorva" linhas
 * seguintes (e chamadas de outras funções) por procurar uma chave de bloco que não é dela.
 */
function fimDeStatement(linhas: string[], inicio: number): number {
  let bal = 0
  let tocou = false
  const limite = Math.min(inicio + MAX_LINHAS_STATEMENT, linhas.length)
  for (let i = inicio; i < limite; i++) {
    const linha = semStringsEComentarios(linhas[i])
    for (const ch of linha) {
      if (ch === "(" || ch === "[" || ch === "{") {
        bal++
        tocou = true
      } else if (ch === ")" || ch === "]" || ch === "}") {
        bal--
        tocou = true
      }
    }
    if (bal <= 0 && (tocou || /[;}]\s*$/.test(linha) || i > inicio)) return i + 1
  }
  return inicio + 1
}

/** Fim de um símbolo em linguagem por indentação (Python/Ruby): próxima linha de código com indent <=. */
function fimPorIndentacao(linhas: string[], inicio: number, indentDef: number, limite: number): number {
  for (let i = inicio + 1; i < limite; i++) {
    const l = linhas[i]
    if (!l.trim() || /^\s*(#|""")/.test(l)) continue
    if (indent(l) <= indentDef) return i
  }
  return limite
}

const RE_HERANCA_KT = /\bclass\s+[A-Za-z_]\w*(?:<[^>]*>)?(?:\s*\([^)]*\))?\s*:\s*([^{]+)/
const RE_HERANCA_JAVA = /\b(?:class|interface)\s+[A-Za-z_]\w*(?:<[^>]*>)?\s+(?:extends|implements)\s+([^{]+)/
const RE_HERANCA_TS = /\b(?:class|interface)\s+[A-Za-z_$][\w$]*(?:<[^>]*>)?\s+(?:extends|implements)\s+([^{<]+)/
const RE_HERANCA_PY = /\bclass\s+[A-Za-z_]\w*\s*\(([^)]+)\)/
const RE_HERANCA_PHP = /\bclass\s+[A-Za-z_]\w*\s+(?:extends|implements)\s+([^{]+)/

/** Nomes das superclasses/interfaces na linha de definição. Só identificadores com inicial maiúscula. */
function heranca(linhaDef: string, ext: string): string[] {
  const re =
    ext === "kt" || ext === "kts" ? RE_HERANCA_KT
    : ext === "java" ? RE_HERANCA_JAVA
    : ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx" ? RE_HERANCA_TS
    : ext === "py" ? RE_HERANCA_PY
    : ext === "php" ? RE_HERANCA_PHP
    : null
  if (!re) return []
  const m = linhaDef.match(re)
  if (!m) return []
  return [
    ...new Set(
      m[1]
        .split(",")
        .map((s) => s.trim().replace(/[<(].*$/, "").replace(/\(\)$/, "").split(/\s+/)[0])
        .map((s) => s.replace(/^.*\./, ""))
        .filter((s) => /^[A-Z]/.test(s)),
    ),
  ]
}

const RE_CHAMADA = /\b([A-Za-z_$][\w$]*)\s*\(/g
const PALAVRAS_CHAMADA = new Set([
  "if", "for", "while", "when", "switch", "catch", "return", "with", "do", "function",
  "fun", "def", "func", "fn", "println", "print", "require", "super", "this", "typeof", "await",
  "val", "var", "let", "const", "new", "throw", "yield", "in", "is", "as",
])

/** Identificadores chamados como função no corpo (resolução real fica pro grafo). Exclui o próprio nome. */
function chamadasNoCorpo(corpo: string, proprio: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  RE_CHAMADA.lastIndex = 0
  while ((m = RE_CHAMADA.exec(corpo))) {
    const nome = m[1]
    if (nome.length > 2 && nome !== proprio && !PALAVRAS_CHAMADA.has(nome)) out.add(nome)
  }
  return [...out]
}

const RE_TIPO_REF = /\b([A-Z][A-Za-z0-9_]{2,})\b/g

/**
 * Tipos PascalCase referenciados num trecho (assinatura/campos): pega injeção por construtor
 * (`val svc: AraraPhoneNumberService`), tipos de retorno e de campo. Vira USA_TIPO no grafo, mas só
 * pra tipos importados — é o que conecta um consumidor ao serviço sob DI, onde não há chamada direta.
 */
function tiposReferenciados(trecho: string, proprio: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  RE_TIPO_REF.lastIndex = 0
  while ((m = RE_TIPO_REF.exec(trecho))) {
    if (m[1] !== proprio) out.add(m[1])
  }
  return [...out]
}

const MAX_LINHAS = 12_000
const CABECALHO_TIPOS = 15

/**
 * Extrai símbolos definidos, imports, assinaturas e ranges [início, fim) de um arquivo-fonte (1.2),
 * por regex específica da linguagem. Linhas 1-based. Ranges via balanceamento de chaves (Kotlin/TS/
 * Java/Go/Rust/PHP) ou indentação (Python/Ruby). v1 cobre símbolos de topo e métodos — suficiente
 * pra extração cirúrgica e pro grafo. Degrada pra {simbolos:[], imports:[]} em linguagem desconhecida.
 */
export function extrairSimbolos(arquivo: string, conteudo: string): ArquivoSimbolos {
  const ext = extOf(arquivo)
  const cfg = POR_EXT[ext]
  if (!cfg) return { arquivo, linguagem: ext || "desconhecida", simbolos: [], imports: [] }
  const linhas = conteudo.split("\n").slice(0, MAX_LINHAS)
  const simbolos: Simbolo[] = []
  const imports = extrairImports(linhas, cfg.spec.imports, ext)

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i]
    if (!linha.trim() || linha.trim().startsWith("//") || linha.trim().startsWith("*")) continue
    for (const regra of cfg.spec.defs) {
      const m = linha.match(regra.re)
      if (!m) continue
      const nome = m[regra.grupo]
      if (!nome || NAO_SIMBOLO.has(nome)) continue
      const statementUnico = regra.tipo === "constante" || regra.tipo === "tipo"
      const fim = statementUnico
        ? fimDeStatement(linhas, i)
        : cfg.spec.chaves
          ? fimPorChaves(linhas, i, linhas.length)
          : fimPorIndentacao(linhas, i, indent(linha), linhas.length)
      const assinatura = assinaturaDe(linhas, i)
      const temCorpo = regra.tipo === "funcao" || regra.tipo === "metodo"
      const ehTipoComPai = regra.tipo === "classe" || regra.tipo === "interface" || regra.tipo === "struct"
      const cabecalho = linhas.slice(i, Math.min(fim, i + CABECALHO_TIPOS)).join("\n")
      simbolos.push({
        nome,
        tipo: regra.tipo,
        arquivo,
        linhaInicio: i + 1,
        linhaFim: fim + 1,
        assinatura,
        herda: ehTipoComPai ? heranca(assinatura, ext) : [],
        chama: temCorpo ? chamadasNoCorpo(linhas.slice(i, fim).join("\n"), nome) : [],
        usaTipo: statementUnico ? [] : tiposReferenciados(cabecalho, nome),
      })
      break
    }
  }
  return { arquivo, linguagem: cfg.lang, simbolos: dedupe(simbolos), imports }
}

function dedupe(simbolos: Simbolo[]): Simbolo[] {
  const vistos = new Set<string>()
  const out: Simbolo[] = []
  for (const s of simbolos) {
    const chave = `${s.nome}:${s.linhaInicio}`
    if (vistos.has(chave)) continue
    vistos.add(chave)
    out.push(s)
  }
  return out
}

function extrairImports(linhas: string[], regras: RegExp[], ext: string): Import[] {
  const out: Import[] = []
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i]
    for (const re of regras) {
      const m = linha.match(re)
      if (!m) continue
      const { alvo, nomes } = interpretarImport(m, ext)
      if (alvo) out.push({ alvo, nomes, linha: i + 1 })
      break
    }
  }
  return out
}

function interpretarImport(m: RegExpMatchArray, ext: string): { alvo: string; nomes: string[] } {
  if (ext === "py") {
    if (m[1]) return { alvo: m[1], nomes: nomesPy(m[2]) }
    return { alvo: nomesPy(m[3])[0] ?? "", nomes: nomesPy(m[3]) }
  }
  if (ext === "kt" || ext === "java") {
    const fqn = m[1] ?? ""
    const nome = fqn.replace(/\.\*$/, "").split(".").pop() ?? ""
    return { alvo: fqn, nomes: nome ? [nome] : [] }
  }
  const alvo = m[1] ?? ""
  return { alvo, nomes: [] }
}

function nomesPy(bruto: string | undefined): string[] {
  if (!bruto) return []
  return bruto
    .replace(/[()]/g, "")
    .split(",")
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean)
}

export type MapaSimbolico = {
  arquivos: ArquivoSimbolos[]
  reverso: Record<string, string[]>
}

/** Monta o índice reverso `nome do símbolo -> arquivos que o definem`. */
export function indiceReverso(arquivos: ArquivoSimbolos[]): Record<string, string[]> {
  const rev: Record<string, Set<string>> = {}
  for (const a of arquivos) {
    for (const s of a.simbolos) {
      ;(rev[s.nome] ??= new Set()).add(a.arquivo)
    }
  }
  const out: Record<string, string[]> = {}
  for (const [nome, set] of Object.entries(rev)) out[nome] = [...set]
  return out
}
