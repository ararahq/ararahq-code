import { pareceReferenciaCodigo, extrairArquivosCitados, type IndiceParaRef } from "./refcodigo"

export type Complexidade = "simples" | "media" | "alta"
export type Modo = "conversa" | "execucao" | "diagnostico" | "compreender" | "planejar" | "comunicar"

const STOPWORDS = new Set([
  "a", "o", "e", "de", "do", "da", "que", "se", "por", "para", "com", "como",
  "os", "as", "um", "uma", "no", "na", "em", "ao", "the", "and", "for",
  "está", "esta", "sendo", "estão", "estao", "ser", "foi", "tem", "ter",
  "qual", "onde", "quando", "porque", "por que", "porquê", "causa", "acha",
  "pra", "isso", "esse", "essa", "mas", "ou", "nao", "não", "sim", "ja", "já",
  "mais", "menos", "muito", "pouco", "todo", "toda", "todos", "todas",

  "instalei", "instalar", "instala", "funciona", "funcionar", "funcionando", "voce", "voces",
  "você", "vocês", "nada", "fala", "falam", "falou", "falar", "usa", "usar", "usando", "lib",
  "libs", "jura", "reclama", "reclamando", "reclamou", "coisa", "coisas", "negocio", "negócio",
])

const SINAIS_ALTA = [
  "arquitetura", "refatora", "seguranca", "segurança", "performance",
  "concorrencia", "concorrência", "race condition", "memory leak",
  "do zero", "reescreve", "debug", "migra",
  "investiga", "rastreia", "diagnostica", "deveria", "esta sendo", "está sendo",
  "ta sendo", "tá sendo", "nao funciona", "não funciona", "bug",
]

const SINAIS_SIMPLES = [
  "explica", "o que é", "o que e", "o que faz", "lista", "exemplo", "resume", "como usar",
]

const SAUDACOES = [
  "oi", "olá", "ola", "e aí", "eai", "bom dia", "boa tarde", "boa noite",
  "tudo bem", "tudo certo", "como vai", "como você", "como voce",
  "beleza", "blz", "valeu", "obrigad", "tchau", "fala aí", "fala ai",
]

const VERBOS_ACAO = [
  "adiciona", "cria", "criar", "refatora", "corrige", "conserta", "roda", "rode",
  "executa", "muda", "mude", "implementa", "escreve", "escreva", "deleta", "remove",
  "apaga", "leia", "mostra", "mostre", "explica", "explique", "analisa", "analise",
  "atualiza", "gera", "ajusta", "otimiza", "testa", "teste", "revisa", "documenta",
  "renomeia", "move", "instala", "configura",
]

export function classificar(input: string): Complexidade {
  const i = input.toLowerCase()
  if (SINAIS_ALTA.some((s) => i.includes(s))) return "alta"
  if (SINAIS_SIMPLES.some((s) => i.includes(s))) return "simples"
  const tokens = i.split(/[^\p{L}\p{Nd}_]+/u).filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  return tokens.length > 40 ? "alta" : "media"
}

const SOBRE = [
  "quem e voce", "quem é voce", "quem é você", "o que voce faz", "o que você faz",
  "o que voce é", "o que você é", "o que voce e", "pra que serve", "pra que voce serve",
  "o que voce pode", "o que você pode", "como voce funciona", "como você funciona",
]

export function ehConversa(input: string, indice?: IndiceParaRef): boolean {
  if (pareceReferenciaCodigo(input, indice)) return false
  const low = input.toLowerCase()
  if (SOBRE.some((s) => low.includes(s))) return true
  if (VERBOS_ACAO.some((v) => low.includes(v))) return false
  const palavras = low.trim().split(/\s+/).filter(Boolean).length
  return palavras <= 6 && SAUDACOES.some((s) => low.includes(s))
}

const SINAIS_PLANEJAR = [
  "como eu faria", "qual a melhor forma", "qual a melhor maneira", "planeja", "planejar", "qual abordagem",
  "como migrar", "como estruturar", "monta um plano", "monta o plano", "faz um plano", "passo a passo pra",
  "passo a passo para", "qual estratégia", "qual estrategia", "como organizar", "antes de fazer", "como abordar",
]

const SINAIS_COMUNICAR = [
  "escreve o commit", "escreva o commit", "mensagem de commit", "msg de commit", "faz o pr", "faça o pr",
  "faz a pr", "descrição do pr", "descricao do pr", "changelog", "release notes", "nota de release",
  "documenta isso pro time", "documenta pro time", "explica essa mudança pro", "escreve o comentário",
  "resume o que mudou", "resumo do que mudou", "descreve a mudança", "descreve essa mudança",
]

const SINAIS_COMPREENDER = [
  "o que faz", "o que esse", "o que essa", "o que este", "como funciona", "como esse", "como essa",
  "me explica o fluxo", "explica o fluxo", "entende esse", "entenda esse", "resume", "resumo",
  "o que é esse projeto", "o que é este projeto", "como esse módulo", "como este modulo", "panorama",
  "visão geral", "visao geral", "lê a doc", "leia a documentação", "leia a documentacao",
  "o que tem em", "me situa", "onde fica a lógica de", "onde fica a logica de", "me mostra como",
]

const SINAIS_DIAGNOSTICO = [
  "por que", "porque está", "porque esta", "porquê", "investiga", "investigar",
  "analisa", "analisar", "analise", "descobre", "descobrir", "qual a causa",
  "qual é a causa", "qual e a causa", "está lento", "esta lento", "ta lento",
  "tá lento", "está errado", "esta errado", "ta errado", "tá errado",
  "não funciona", "nao funciona", "não está funcionando", "nao esta funcionando",
  "às vezes", "as vezes", "deveria", "como resolver", "o que está causando",
  "o que esta causando", "diagnostica", "diagnosticar", "acha o problema",
  "acha a causa", "ache a causa", "ache o problema", "salva errado", "salvando errado",
  "está salvando", "esta salvando", "ta salvando", "tá salvando", "rastreia",
  "rastrear", "qual o motivo", "o que faz com que",
]

const SINAIS_EXECUCAO = [
  "adiciona", "adicionar", "cria", "criar", "renomeia", "renomear", "troca",
  "trocar", "substitui", "substituir", "corrige a linha", "na linha", "no método",
  "no metodo", "implementa", "implementar", "move", "mover", "deleta", "deletar",
  "formata", "formatar", "extrai para", "extrair para", "extrai o", "remove o",
  "remove a", "remover o", "remover a", "muda o nome", "altera a linha",
]

export function decidirModo(input: string, indice?: IndiceParaRef): Modo {
  if (ehConversa(input, indice)) return "conversa"
  const i = input.toLowerCase()

  if (SINAIS_COMUNICAR.some((s) => i.includes(s))) return "comunicar"
  if (SINAIS_PLANEJAR.some((s) => i.includes(s))) return "planejar"

  const temExecucao = SINAIS_EXECUCAO.some((s) => i.includes(s))

  if (SINAIS_COMPREENDER.some((s) => i.includes(s)) && !temExecucao) return "compreender"

  const temDiagnostico = SINAIS_DIAGNOSTICO.some((s) => i.includes(s))

  if (temExecucao && !temDiagnostico) return "execucao"
  if (temDiagnostico && !temExecucao) return "diagnostico"
  if (temDiagnostico && temExecucao) {

    return pareceReferenciaCodigo(input, indice) ? "execucao" : "diagnostico"
  }

  return classificar(input) === "alta" ? "diagnostico" : "execucao"
}

const VERBOS_CORRECAO = [
  "corrige", "conserta", "arruma", "cria", "criar", "implementa", "implementar", "adiciona",
  "adicionar", "aplica", "ajusta", "refatora", "escreve", "escreva", "troca", "substitui",
  "remove", "deleta", "move", "renomeia", "atualiza", "gera", "correção", "correcao",
]

const RE_CONECTOR_COMPOSTA = /\b(?:e|depois|então|entao|aí|daí|em seguida|por fim)\b|,/

export type Composta =
  | { tipo: "encadeada"; intencoes: Modo[] }
  | { tipo: "demais" }

export function detectarComposta(input: string, indice?: IndiceParaRef): Composta | null {
  if (ehConversa(input, indice)) return null
  const i = input.toLowerCase()
  const temDiag = SINAIS_DIAGNOSTICO.some((s) => i.includes(s))
  const temCorrecao = VERBOS_CORRECAO.some((v) => i.includes(v))
  if (!temDiag || !temCorrecao) return null
  if (!RE_CONECTOR_COMPOSTA.test(input)) return null

  const clausulasComVerbo = input
    .split(RE_CONECTOR_COMPOSTA)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => SINAIS_DIAGNOSTICO.some((s) => p.includes(s)) || VERBOS_CORRECAO.some((v) => p.includes(v)))
    .length
  if (clausulasComVerbo >= 3) return { tipo: "demais" }
  return { tipo: "encadeada", intencoes: ["diagnostico", "execucao"] }
}

const TERMOS_DOMINIO = new Set([
  "shared", "dedicated", "compartilhado", "compartilhada", "compartilhados", "compartilhadas",
  "dedicado", "dedicada", "dedicados", "dedicadas", "numero", "numeros", "número", "números",
  "webhook", "token", "credito", "creditos", "crédito", "créditos", "billing", "subscription",
  "template", "campaign", "campanha", "message", "mensagem", "org", "organization",
])

const GENERICOS = new Set([
  "number", "numero", "numeros", "número", "números", "message", "mensagem",
  "org", "token", "credit", "credito", "creditos", "crédito", "créditos", "salvos", "salvo",
])

const SINONIMOS_EN: Record<string, string[]> = {
  compartilhado: ["shared"], compartilhada: ["shared"], compartilhados: ["shared"], compartilhadas: ["shared"],
  dedicado: ["dedicated"], dedicada: ["dedicated"], dedicados: ["dedicated"], dedicadas: ["dedicated"],
  numero: ["number"], numeros: ["number"], número: ["number"], números: ["number"],
  credito: ["credit"], creditos: ["credit"], crédito: ["credit"], créditos: ["credit"],
  campanha: ["campaign"], mensagem: ["message"], organizacao: ["organization"], organização: ["organization"],
}

export function ehGenerico(termo: string): boolean {
  return GENERICOS.has(termo.toLowerCase())
}

const RE_CAMEL = /([a-z])([A-Z])/g

function quebrarCamel(token: string): string[] {
  return token.replace(RE_CAMEL, "$1 $2").split(/\s+/).filter(Boolean)
}

export function extrairEntidades(input: string): string[] {
  const brutos = input
    .toLowerCase()
    .split(/[^\p{L}\p{Nd}_]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))

  const expandidos = new Set<string>()
  const traduzidos = new Set<string>()
  for (const w of brutos) {
    for (const parte of quebrarCamel(w)) {
      const p = parte.toLowerCase()
      if (p.length >= 3 && !STOPWORDS.has(p)) expandidos.add(p)
    }
    expandidos.add(w)
    for (const en of SINONIMOS_EN[w] ?? []) traduzidos.add(en)
  }

  const dominioEnEspecifico = [...traduzidos].filter((w) => !GENERICOS.has(w))
  const dominioPtEspecifico = [...expandidos].filter((w) => TERMOS_DOMINIO.has(w) && !GENERICOS.has(w))
  const restoEspecifico = [...expandidos].filter((w) => !TERMOS_DOMINIO.has(w) && !GENERICOS.has(w))
  const genericos = [...new Set([...traduzidos, ...expandidos])].filter((w) => GENERICOS.has(w))

  const dominio = [...new Set([...dominioEnEspecifico, ...dominioPtEspecifico])]
  if (dominio.length >= 2) return dominio.slice(0, 8)
  const ordenados = [...new Set([...dominio, ...restoEspecifico, ...genericos])]
  return ordenados.slice(0, 10)
}

export function perfilTermos(texto: string): Map<string, number> {
  const freq = new Map<string, number>()
  const add = (t: string) => {
    const p = t.toLowerCase()
    if (p.length >= 3 && !STOPWORDS.has(p)) freq.set(p, (freq.get(p) ?? 0) + 1)
  }
  for (const bruto of texto.split(/[^\p{L}\p{Nd}]+/u)) {
    if (!bruto) continue
    for (const camel of quebrarCamel(bruto)) {
      for (const parte of camel.split("_")) if (parte) add(parte)
    }
    if (bruto.includes("_")) for (const parte of bruto.split("_")) if (parte) add(parte)
    else add(bruto)
  }
  return freq
}

export function resumoExtrativo(texto: string, n = 12): string[] {
  return [...perfilTermos(texto).entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([t]) => t)
}

export type MudancaDiff = { arquivo: string; adicoes: number; remocoes: number; score: number }

export function pontuarDiff(diff: string): MudancaDiff[] {
  const out: MudancaDiff[] = []
  let atual: { arquivo: string; add: number; rem: number; texto: string } | null = null
  const fechar = () => {
    if (atual) out.push({ arquivo: atual.arquivo, adicoes: atual.add, remocoes: atual.rem, score: perfilTermos(atual.texto).size + Math.min(atual.add + atual.rem, 40) })
  }
  for (const linha of diff.split("\n")) {
    const m = linha.match(/^\+\+\+ b\/(.+)$/)
    if (m) {
      fechar()
      atual = { arquivo: m[1], add: 0, rem: 0, texto: "" }
      continue
    }
    if (!atual) continue
    if (linha.startsWith("+") && !linha.startsWith("+++")) {
      atual.add++
      atual.texto += `${linha.slice(1)}\n`
    } else if (linha.startsWith("-") && !linha.startsWith("---")) {
      atual.rem++
      atual.texto += `${linha.slice(1)}\n`
    }
  }
  fechar()
  return out.sort((a, b) => b.score - a.score)
}

const PONTE_DOMINIO: { pre: string; alvos: string[] }[] = [
  { pre: "recarr", alvos: ["recharge", "credit", "topup", "balance"] },
  { pre: "saldo", alvos: ["balance", "credit", "wallet"] },
  { pre: "cred", alvos: ["credit"] },
  { pre: "pag", alvos: ["payment", "pay", "checkout"] },
  { pre: "cobr", alvos: ["charge", "billing"] },
  { pre: "estorn", alvos: ["refund"] },
  { pre: "reembol", alvos: ["refund"] },
  { pre: "fatur", alvos: ["invoice", "billing"] },
  { pre: "dobr", alvos: ["double", "duplicate"] },
  { pre: "duplic", alvos: ["duplicate"] },
  { pre: "carteira", alvos: ["wallet", "balance"] },
  { pre: "conta", alvos: ["account", "organization", "user", "wallet"] },
  { pre: "cliente", alvos: ["user", "customer", "organization", "account"] },
  { pre: "bonus", alvos: ["bonus", "credit"] },
  { pre: "bônus", alvos: ["bonus", "credit"] },
  { pre: "ativ", alvos: ["activate", "active", "enable"] },
  { pre: "import", alvos: ["import"] },
  { pre: "conex", alvos: ["connection", "connect", "client", "url"] },
  { pre: "conect", alvos: ["connection", "connect", "client"] },
  { pre: "perfil", alvos: ["profile", "user"] },
  { pre: "mensag", alvos: ["message", "send"] },
  { pre: "template", alvos: ["template"] },
  { pre: "webhook", alvos: ["webhook", "callback"] },
  { pre: "segred", alvos: ["secret", "signature", "hmac"] },
  { pre: "secret", alvos: ["secret", "signature", "hmac"] },
  { pre: "assinatura", alvos: ["signature", "sign"] },
  { pre: "ativa", alvos: ["activate", "active", "enable"] },
]

export function expandirDominio(tokens: string[], vocab?: Set<string>): string[] {
  const out = new Set(tokens.map((t) => t.toLowerCase()))
  for (const t of out) {
    for (const { pre, alvos } of PONTE_DOMINIO) {
      if (t.startsWith(pre)) for (const a of alvos) if (!vocab || vocab.has(a)) out.add(a)
    }
  }
  return [...out]
}

const RE_STACK_TRACE =
  /\bat\s+[\w$.<>]+\s*\([^)]*:\d+\)|traceback \(most recent call last\)|file "[^"]+", line \d+|panic:\s|goroutine \d+ \[|\n\s*at .+?:\d+:\d+/i

export function temStackTrace(input: string): boolean {
  return RE_STACK_TRACE.test(input)
}

export type Tamanho = "pequeno" | "medio" | "grande"

export function tamanhoPrevisto(input: string): Tamanho {
  const linhas = input.split("\n").length
  const chars = input.length
  const arquivos = extrairArquivosCitados(input).length
  if (linhas > 40 || chars > 2500 || arquivos >= 4) return "grande"
  if (linhas > 12 || chars > 700 || arquivos >= 2) return "medio"
  return "pequeno"
}

const RE_SEGUIMENTO =
  /^\s*(e|agora|então|entao|isso|esse|essa|aplica|conserta|corrige|arruma|faz isso|vai|manda|continua|pode|ok|certo|sim)\b|\bisso\b|\bdesse jeito\b|\be a linha\b/i

export function pareceSeguimento(input: string): boolean {
  const palavras = input.trim().split(/\s+/).filter(Boolean).length
  return palavras <= 8 && RE_SEGUIMENTO.test(input)
}

const RE_ACAO_FEITA =
  /\b(editei|alterei|corrigi|criei|removi|adicionei|apliquei|troquei|substitu[ií])\b|editar_arquivo|linha \d+/i
const RE_DUVIDA =
  /\b(não tenho certeza|nao tenho certeza|talvez|pode ser que|poderia ser|não sei|nao sei|me aponta|qual arquivo|onde (?:está|esta|fica|devo))\b/i

export function respostaHedge(resposta: string): boolean {
  if (RE_ACAO_FEITA.test(resposta)) return false
  return RE_DUVIDA.test(resposta)
}

export type Edicao = { arquivo: string; ancora: string; novo: string }

export function detectarContradicao(anteriores: Edicao[], nova: Edicao): boolean {
  for (const a of anteriores) {
    if (a.arquivo !== nova.arquivo) continue
    if (a.ancora === nova.novo && a.novo === nova.ancora) return true
  }
  return false
}
