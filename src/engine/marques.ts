export type Complexidade = "simples" | "media" | "alta"
export type Modo = "conversa" | "execucao" | "diagnostico"

const STOPWORDS = new Set([
  "a", "o", "e", "de", "do", "da", "que", "se", "por", "para", "com", "como",
  "os", "as", "um", "uma", "no", "na", "em", "ao", "the", "and", "for",
  "está", "esta", "sendo", "estão", "estao", "ser", "foi", "tem", "ter",
  "qual", "onde", "quando", "porque", "por que", "porquê", "causa", "acha",
  "pra", "isso", "esse", "essa", "mas", "ou", "nao", "não", "sim", "ja", "já",
  "mais", "menos", "muito", "pouco", "todo", "toda", "todos", "todas",
  // prosa conversacional de ticket de suporte: vira termo de busca e casa lixo (errors.ts, etc.)
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

const REF_CODIGO = /[\w./-]+\.(kt|kts|java|ts|tsx|js|jsx|py|go|rs|sql|json|ya?ml|md)\b|[A-Z]\w*(Exception|Error)\b|\b\w+\(/

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

export function ehConversa(input: string): boolean {
  if (REF_CODIGO.test(input)) return false
  const low = input.toLowerCase()
  if (SOBRE.some((s) => low.includes(s))) return true
  if (VERBOS_ACAO.some((v) => low.includes(v))) return false
  const palavras = low.trim().split(/\s+/).filter(Boolean).length
  return palavras <= 6 && SAUDACOES.some((s) => low.includes(s))
}

// Eixo 1 — thinking ON. Sintoma sem causa apontada: o agente precisa descobrir.
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

// Eixo 1 — thinking OFF. Instrução cirúrgica: o que fazer já está dito.
const SINAIS_EXECUCAO = [
  "adiciona", "adicionar", "cria", "criar", "renomeia", "renomear", "troca",
  "trocar", "substitui", "substituir", "corrige a linha", "na linha", "no método",
  "no metodo", "implementa", "implementar", "move", "mover", "deleta", "deletar",
  "formata", "formatar", "extrai para", "extrair para", "extrai o", "remove o",
  "remove a", "remover o", "remover a", "muda o nome", "altera a linha",
]

/**
 * Decide o modo de operação (Eixo 1).
 * - conversa: saudação/meta-pergunta (vai pro Ollama no agent).
 * - diagnostico: sintoma sem causa apontada -> thinking ON (raciocínio + comparação).
 * - execucao: instrução pronta -> thinking OFF (modelo barato e rápido).
 * Regra de desempate: cita arquivo+método+mudança exata -> execução; senão classificar()=="alta" -> diagnóstico.
 */
export function decidirModo(input: string): Modo {
  if (ehConversa(input)) return "conversa"
  const i = input.toLowerCase()

  const temDiagnostico = SINAIS_DIAGNOSTICO.some((s) => i.includes(s))
  const temExecucao = SINAIS_EXECUCAO.some((s) => i.includes(s))

  // Instrução cirúrgica explícita (verbo de ação + alvo nomeado) vence: é execução, sem thinking.
  if (temExecucao && !temDiagnostico) return "execucao"
  if (temDiagnostico && !temExecucao) return "diagnostico"
  if (temDiagnostico && temExecucao) {
    // Ambíguo: se aponta um arquivo/símbolo concreto, é execução; senão investiga.
    return REF_CODIGO.test(input) ? "execucao" : "diagnostico"
  }

  // Nenhum sinal claro: cai no classificador de complexidade.
  return classificar(input) === "alta" ? "diagnostico" : "execucao"
}

const TERMOS_DOMINIO = new Set([
  "shared", "dedicated", "compartilhado", "compartilhada", "compartilhados", "compartilhadas",
  "dedicado", "dedicada", "dedicados", "dedicadas", "numero", "numeros", "número", "números",
  "webhook", "token", "credito", "creditos", "crédito", "créditos", "billing", "subscription",
  "template", "campaign", "campanha", "message", "mensagem", "org", "organization",
])

// Termos de domínio que, isolados, casam ruído demais (prosa, config, build). Só entram na busca
// quando não há termo mais distintivo — e nunca enterram os específicos como 'shared'/'dedicated'.
const GENERICOS = new Set([
  "number", "numero", "numeros", "número", "números", "message", "mensagem",
  "org", "token", "credit", "credito", "creditos", "crédito", "créditos", "salvos", "salvo",
])

// O código real é majoritariamente em inglês; o sintoma vem em PT. Mapeia os termos de domínio
// pra suas formas em inglês, pra busca casar com identificadores (isShared) e não só prosa.
const SINONIMOS_EN: Record<string, string[]> = {
  compartilhado: ["shared"], compartilhada: ["shared"], compartilhados: ["shared"], compartilhadas: ["shared"],
  dedicado: ["dedicated"], dedicada: ["dedicated"], dedicados: ["dedicated"], dedicadas: ["dedicated"],
  numero: ["number"], numeros: ["number"], número: ["number"], números: ["number"],
  credito: ["credit"], creditos: ["credit"], crédito: ["credit"], créditos: ["credit"],
  campanha: ["campaign"], mensagem: ["message"], organizacao: ["organization"], organização: ["organization"],
}

/** Termo genérico demais pra busca isolada (casa prosa/config). Usado pra priorizar a alternância. */
export function ehGenerico(termo: string): boolean {
  return GENERICOS.has(termo.toLowerCase())
}

const RE_CAMEL = /([a-z])([A-Z])/g

/** Quebra camelCase/PascalCase em palavras: isSharedNumber -> [is, shared, number]. */
function quebrarCamel(token: string): string[] {
  return token.replace(RE_CAMEL, "$1 $2").split(/\s+/).filter(Boolean)
}

/**
 * Extrai os termos relevantes de um sintoma pra alimentar o mapa de comparação.
 * Tokeniza, remove stopwords PT-BR, traduz domínio PT->EN (o código é em inglês) e ordena por
 * especificidade: termos distintivos (shared, dedicated) primeiro, genéricos (number, message) por último.
 * Termos isolados já casam identificadores compostos por substring no grep (isShared, sharedNumber).
 */
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

  // Específicos primeiro (EN distintivo + domínio PT específico), depois o resto, genéricos por último.
  const dominioEnEspecifico = [...traduzidos].filter((w) => !GENERICOS.has(w))
  const dominioPtEspecifico = [...expandidos].filter((w) => TERMOS_DOMINIO.has(w) && !GENERICOS.has(w))
  const restoEspecifico = [...expandidos].filter((w) => !TERMOS_DOMINIO.has(w) && !GENERICOS.has(w))
  const genericos = [...new Set([...traduzidos, ...expandidos])].filter((w) => GENERICOS.has(w))
  // Se há termos de DOMÍNIO suficientes, use só eles. Prosa ("test", "modo", "ux", "usuario", "problema")
  // polui a busca e puxa o projeto errado num monorepo — resto/genéricos só entram como último recurso.
  const dominio = [...new Set([...dominioEnEspecifico, ...dominioPtEspecifico])]
  if (dominio.length >= 2) return dominio.slice(0, 8)
  const ordenados = [...new Set([...dominio, ...restoEspecifico, ...genericos])]
  return ordenados.slice(0, 10)
}

// 3.0 — STACK_TRACE colado: frame com arquivo:linha (Java/Kotlin/JS), Traceback (Python), panic (Go).
// É bug real pra diagnosticar, não pergunta — sobrepõe o classificador de palavra-chave no roteamento.
const RE_STACK_TRACE =
  /\bat\s+[\w$.<>]+\s*\([^)]*:\d+\)|traceback \(most recent call last\)|file "[^"]+", line \d+|panic:\s|goroutine \d+ \[|\n\s*at .+?:\d+:\d+/i

export function temStackTrace(input: string): boolean {
  return RE_STACK_TRACE.test(input)
}

export type Tamanho = "pequeno" | "medio" | "grande"

const RE_ARQUIVO_CITADO =
  /\b[\w./-]+\.(?:kt|kts|java|ts|tsx|js|jsx|py|go|rs|php|rb|sql|json|ya?ml)\b/gi

// 3.0 — Tamanho previsto da tarefa por linhas, caracteres e quantos arquivos o input cita. Vira
// escolha de marcha (grande -> loop longo). Heurística barata, sem chamar modelo.
export function tamanhoPrevisto(input: string): Tamanho {
  const linhas = input.split("\n").length
  const chars = input.length
  const arquivos = (input.match(RE_ARQUIVO_CITADO) ?? []).length
  if (linhas > 40 || chars > 2500 || arquivos >= 4) return "grande"
  if (linhas > 12 || chars > 700 || arquivos >= 2) return "medio"
  return "pequeno"
}

// 3.0 — Herança de contexto: um seguimento curto ("agora conserta", "e a linha 82?", "isso") logo
// após um diagnóstico herda o modo diagnóstico, em vez de virar execução/conversa solta.
const RE_SEGUIMENTO =
  /^\s*(e|agora|então|entao|isso|esse|essa|aplica|conserta|corrige|arruma|faz isso|vai|manda|continua|pode|ok|certo|sim)\b|\bisso\b|\bdesse jeito\b|\be a linha\b/i

export function pareceSeguimento(input: string): boolean {
  const palavras = input.trim().split(/\s+/).filter(Boolean).length
  return palavras <= 8 && RE_SEGUIMENTO.test(input)
}

// 3.5 — Resposta hedge: o modelo NÃO agiu (não cita ação feita nem arquivo:linha) e expressa dúvida
// ou devolve a pergunta. Sinal de que a tarefa roteada como execução era, na real, um diagnóstico.
const RE_ACAO_FEITA =
  /\b(editei|alterei|corrigi|criei|removi|adicionei|apliquei|troquei|substitu[ií])\b|editar_arquivo|linha \d+/i
const RE_DUVIDA =
  /\b(não tenho certeza|nao tenho certeza|talvez|pode ser que|poderia ser|não sei|nao sei|me aponta|qual arquivo|onde (?:está|esta|fica|devo))\b/i

export function respostaHedge(resposta: string): boolean {
  if (RE_ACAO_FEITA.test(resposta)) return false
  return RE_DUVIDA.test(resposta)
}

// Linguagem/ecossistema citado no sintoma ("a lib de python", "no php", "cliente node"). É um
// LOCALIZADOR forte num monorepo poliglota: escopa a busca pros arquivos daquele ecossistema, em vez
// de casar prosa espalhada por todos os repos. Cada entrada: termos que disparam + extensões do escopo.
const LINGUAGENS: { lang: string; termos: string[]; exts: string[] }[] = [
  { lang: "python", termos: ["python", "pydantic", "pip", "django", "flask"], exts: [".py"] },
  { lang: "php", termos: ["php", "composer", "laravel"], exts: [".php"] },
  { lang: "node", termos: ["node", "nodejs", "npm", "javascript", "typescript"], exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] },
  { lang: "java", termos: ["java", "kotlin", "gradle", "maven", "spring"], exts: [".java", ".kt", ".kts"] },
  { lang: "ruby", termos: ["ruby", "rails", "bundler"], exts: [".rb"] },
  { lang: "go", termos: ["golang"], exts: [".go"] },
]

/**
 * Linguagens citadas, ORDENADAS pela primeira aparição no texto. A primeira costuma ser o SUJEITO da
 * reclamação ("a lib de PYTHON não funciona, no node funciona") — quem escopa usa a primeira, não
 * todas, senão num contraste ("X quebra, Y funciona") puxa o escopo do Y (o que funciona) junto. Pura.
 */
export function linguagensCitadas(input: string): { lang: string; exts: string[] }[] {
  const low = input.toLowerCase()
  const achados: { lang: string; exts: string[]; pos: number }[] = []
  for (const l of LINGUAGENS) {
    let min = Infinity
    for (const t of l.termos) {
      const m = low.search(new RegExp(`\\b${t}\\b`))
      if (m >= 0 && m < min) min = m
    }
    if (min < Infinity) achados.push({ lang: l.lang, exts: l.exts, pos: min })
  }
  return achados.sort((a, b) => a.pos - b.pos).map(({ lang, exts }) => ({ lang, exts }))
}
