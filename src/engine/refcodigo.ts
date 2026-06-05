// 3.7 — Detecção de referência de arquivo/código AGNÓSTICA de linguagem.
//
// Detectar "o input cita código?" por lista FECHADA de extensões (.kt, .ts, .py…) falha em silêncio
// quando aparece .cpp, .sh, .rb, .swift, .dockerfile fora da lista — e falha silenciosa piora o
// roteamento sem alarme. Aqui a ordem é a do doc:
//   1. PRIMEIRO cruza com o índice real do projeto (Camada 1): token que bate com arquivo/símbolo
//      que o índice de fato encontrou É referência de código — agnóstico de verdade.
//   2. FALLBACK (sem índice ainda): reconhece o PADRÃO, não a extensão: `nome.ext` (ext começa com
//      letra, 2-10 chars), caminho com `/`, ou identificador camelCase/PascalCase.
// Regra de ouro: a AUSÊNCIA de extensão conhecida NUNCA significa "não é código" — cai no padrão/índice.

// Shape mínimo do índice (Camada 1) de que precisamos. Estrutural: o `Indice` completo encaixa aqui.
export type IndiceParaRef = {
  simbolos: { arquivo: string }[]
  reverso: Record<string, string[]>
}

// `nome.ext` agnóstico: ext COMEÇA com letra e tem 2-10 chars alnum. Começar com letra exclui versão
// (`1.5`, `3.14`) sem precisar listar extensões. Cobre .cpp .sh .rb .swift .dockerfile .kt — qualquer uma.
const RE_ARQUIVO_FONTE = /[\w./-]*\w\.[A-Za-z][A-Za-z0-9]{1,9}\b/
const RE_ARQUIVO_FONTE_G = /[\w./-]*\w\.[A-Za-z][A-Za-z0-9]{1,9}\b/g
// Caminho com `/`: pelo menos um segmento separado por barra (src/agent/foo, app/page).
const RE_CAMINHO = /\b[\w-]+\/[\w./-]+/
// Identificador de código: camelCase (isShared) ou PascalCase com 2+ palavras (AraraPhoneNumberService).
// Palavra única capitalizada (Java, Python, String) NÃO casa — é prosa/tipo solto, não referência.
const RE_IDENT = /\b[a-z][a-z0-9]*[A-Z]\w*|\b(?:[A-Z][a-z0-9]+){2,}\b/
// Chamada de função colada no parêntese (`salvar(`); espaço antes do `(` é prosa ("depois (talvez)").
const RE_CHAMADA = /\b\w+\(/
// Exceção/erro nomeado (LinkNotFoundException, ParseError) — sinal forte de stack/diagnóstico.
const RE_EXCECAO = /\b[A-Z]\w*(?:Exception|Error)\b/

/** Quebra o input em tokens candidatos a nome de arquivo/símbolo (preserva `/`, `.`, `-`, `_`). */
function tokens(input: string): string[] {
  return input.split(/[^\w./-]+/).filter(Boolean)
}

/**
 * Tokens do input que o índice REALMENTE conhece: bate com um caminho de arquivo, um base name de
 * arquivo, ou um nome de símbolo definido no projeto. É o sinal "index-first" — confiança alta,
 * agnóstico de extensão. Vazio quando não há índice carregado ou nada bate.
 */
export function refsNoIndice(input: string, indice: IndiceParaRef): string[] {
  const arquivos = new Set<string>()
  const bases = new Set<string>()
  for (const a of indice.simbolos) {
    arquivos.add(a.arquivo)
    const base = a.arquivo.split("/").pop()
    if (base) bases.add(base)
  }
  const simbolos = new Set(Object.keys(indice.reverso))
  const out = new Set<string>()
  for (const t of tokens(input)) {
    const base = t.split("/").pop() ?? t
    if (arquivos.has(t) || bases.has(t) || bases.has(base) || simbolos.has(t)) out.add(t)
  }
  return [...out]
}

/**
 * O input cita código? Index-first (1), padrão como fallback (2). NUNCA depende de lista de extensão.
 * `indice` é opcional: o roteamento puro funciona só com o padrão; quando o agent tem o índice
 * carregado, ele confirma tokens reais e pega referências que o padrão sozinho perderia.
 */
export function pareceReferenciaCodigo(input: string, indice?: IndiceParaRef): boolean {
  if (indice && refsNoIndice(input, indice).length > 0) return true
  return (
    RE_ARQUIVO_FONTE.test(input) ||
    RE_CAMINHO.test(input) ||
    RE_IDENT.test(input) ||
    RE_CHAMADA.test(input) ||
    RE_EXCECAO.test(input)
  )
}

/**
 * Extrai os caminhos de arquivo citados no texto (padrão `nome.ext` agnóstico). Usado pra contar
 * arquivos no tamanho previsto (3.0) e pra extrair o escopo do diagnóstico mastigado (Camada 4).
 * Normaliza removendo `./` inicial. Dedupe preservando ordem de aparição.
 */
export function extrairArquivosCitados(input: string): string[] {
  const out: string[] = []
  const vistos = new Set<string>()
  for (const m of input.matchAll(RE_ARQUIVO_FONTE_G)) {
    const arq = m[0].replace(/^\.\//, "")
    if (!vistos.has(arq)) {
      vistos.add(arq)
      out.push(arq)
    }
  }
  return out
}
