// Dicionário determinístico de ANTI-PADRÕES (zero modelo, custo só de grep). Destilado de como um agente
// forte (Claude Code) resolve ticket leigo: traduz o sintoma → MECANISMO em código e grepa isso. Os
// PADRÕES de código são universais (TODO/stub, dedup, lock não-atômico, fail-open, SSRF, XSS) — conhecimento
// de engenharia, não fato do repo. Precedente no codebase: FAMILIAS_OP (tabela fixa de famílias de op).
// Genérico ≠ chumbado: nenhuma entrada cita ARQUIVO; cita PADRÃO de código que vale em qualquer repo.
//
// ⚠️ Limite honesto: o `intencao` (casar o RELATO leigo) é o elo frágil — depende da frase do usuário, e
// é o que mais arrisca overfit no benchmark. A robustez real vem de parear com a tradução do modelo barato
// (que já roda no pipeline). Aqui é a camada GRÁTIS: quando a frase casa, surge o candidato sem gastar key.
import type { Indice } from "../conhecimento"
import { grep, ranquearCandidatos, type Candidato } from "./navegacao"

// `langs` = extensões em que o padrão é VÁLIDO (vazio = universal). AGNOSTICISMO: a Jade roda em qualquer
// linguagem; o CONCEITO do anti-padrão é universal, mas a ASSINATURA é específica — e `==` é o exemplo
// perfeito: `x == "lit"` é BUG em Java, mas CORRETO em Python/Kotlin (lá `==` compara valor). Um padrão
// chapado misfiraria em Python. Então gateamos pela extensão do arquivo (derivada do repo real, não tabela
// global chumbada). Em repo Python, o pack Java nem é avaliado → zero falso-positivo entre linguagens.
export type Smell = { classe: string; intencao: RegExp; padrao: string; langs?: string[] }

// Arquivo de TESTE/fixture/mock — um anti-padrão aqui quase nunca é o bug de PRODUÇÃO (foi o que eu
// rejeitei em toda jogada manual: hits de "segredo" eram 100% teste; o top candidato do #18 era MutexTest).
// Path-based, geral, zero modelo. Conserta também o locator lexical (que surfava o arquivo de teste no topo).
export function ehArquivoDeTeste(caminho: string): boolean {
  return /(^|\/)(tests?|specs?|__tests__|__mocks__)(\/|$)|\.(test|spec)\.[a-z]+$|(Test|Tests|Spec|IT)\.[A-Za-z]+$/.test(caminho)
}

/** Extensão (minúscula) do caminho — a "linguagem" do arquivo, derivada do próprio repo (não chumbada). */
export function extDe(caminho: string): string {
  const i = caminho.lastIndexOf(".")
  return i < 0 ? "" : caminho.slice(i + 1).toLowerCase()
}

export const SMELLS: Smell[] = [
  // stub: só as formas que ESTOURAM em runtime (TODO()/NotImplemented), não comentário "// TODO"/FIXME (benigno).
  { classe: "stub", intencao: /n[ãa]o? termin|inacab|pela metade|nem (feito|fizeram|terminaram)|incomplet|n[ãa]o (foi|ta) (feito|pronto)/i, padrao: "TODO\\(|not yet impl|notimplementederror|raise NotImplemented|throw.{0,20}NotImplemented" },
  { classe: "dedup", intencao: /pessoa errada|destinat[aá]ri|trocou (o|a)|foi pra (outr|quem)|mensagem.*(errad|trocad)/i, padrao: "distinctBy|associateBy|groupBy|\\.toMap\\(|dedup" },
  { classe: "error-class", intencao: /culpa.*client|sempre.*(erro|falh)|n[ãa]o.*(retent|tenta de novo)|trata.*erro.*errad/i, padrao: "statusCode|\\bit\\.code\\b|CLIENT_ERROR|SERVER_ERROR|getOrElse" },
  { classe: "fail-open-auth", intencao: /sem senha|senha em branco|qualquer um (entra|acessa|passa)|sem (credencial|autentic)|libera(do)? sem/i, padrao: "process\\.env\\.[A-Z_]*(PASS|USER|SECRET|TOKEN)|verify\\s*=\\s*false|===\\s*process\\.env" },
  // timing-compare: exclui `Objects.equals(...)` (igualdade de entity, não segurança — falso-positivo comum em Java).
  { classe: "timing-compare", intencao: /forj(ar|a|am)|se passar (por|como)|assinatura (fraca|falsa|burl)|d[áa] pra (passar|forjar|fingir|burlar)|seguran[çc]a (falou|disse|achou)|burlar|spoofar/i, padrao: "(signature|hmac|verifytoken|verify_token|digest)\\s*(==|!=)\\s*(?!null)|(?<!Objects)\\.equals\\([^)]*(signature|hmac|token|secret)" },
  // wrong-equality: comparar VALOR com operador de IDENTIDADE. CONCEITO universal, ASSINATURA por linguagem (gateada).
  // Java: `x == "lit"` compara referência (bug). Em Kotlin/Python `==` é valor (correto) → NÃO entram no pack.
  { classe: "eq-java", langs: ["java"], intencao: /condi[çc][ãa]o.*(nunca|n[ãa]o).*(pega|bate|funciona|entra)|compara[çc][ãa]o.*(errad|n[ãa]o funciona)|nunca (entra|cai|é verdadeir)|string.*(compar|igual)/i, padrao: "[\\w)\\]]\\s*(==|!=)\\s*\"" },
  // Python: `x is "lit"`/`x is 5` usa identidade pra valor (bug; funciona por acaso via interning).
  { classe: "eq-python", langs: ["py"], intencao: /condi[çc][ãa]o.*(nunca|n[ãa]o).*(pega|bate|funciona|entra)|compara[çc][ãa]o.*(errad|n[ãa]o funciona)|nunca (entra|cai|é verdadeir)/i, padrao: "\\bis\\s+[\"'\\d]" },
  // cors-wildcard: origem `*` em allowlist de segurança (CSWSH/CSRF). Assinatura quase universal → sem gate.
  { classe: "cors-wildcard", intencao: /qualquer (site|origem|lugar|um de fora)|cross.?site|\bcors\b|de qualquer (origem|lugar)|origem.*liberad|hijack/i, padrao: "(allowedorigins?|allow-origin|cross.?origin|setallowedorigin)[^\\n]{0,25}[\"']\\*[\"']" },
  { classe: "lock", intencao: /duas vezes|duplicad?|repetid|mesma (mensagem|coisa).*(vez|duas)|v[áa]rios servidor|ao mesmo tempo|concorr/i, padrao: "setIfAbsent|setnx|\\bMutex\\b|\\block\\b|synchronized|setExpiration" },
  { classe: "lost-msg", intencao: /some(m|u)?|sumi|evapor|n[ãa]o (chega|recebe|recebeu)|perde(u|ndo)|nunca tenta de novo/i, padrao: "deletionPolicy|ALWAYS|catch\\s*\\(|\\back\\b|acknowledge|sys\\.exit" },
  { classe: "stuck-ttl", intencao: /trava.*(sempre|pra sempre)|nunca volta|bloquead.*sempre|n[ãa]o volta nem reinic/i, padrao: "setIfAbsent|\\bexpire\\b|setTtl|setExpiration|EXPIRE" },
  { classe: "pii-leak", intencao: /(cpf|telefone|dados?).*(link|p[úu]blic|sem senha)|vazou|abriu.*(arquivo|csv).*sem/i, padrao: "PublicRead|public-read|CannedAccessControlList|setPublic|ACL" },
  { classe: "ssrf", intencao: /servidor.*(busca|baixa|alcan).*(qualquer|o que mand|interno)|laranja|de fora.*nosso servidor/i, padrao: "requests\\.get|fetch\\(|RestTemplate|HttpClient|urlopen" },
  { classe: "xss", intencao: /tela.*(estranh|coisa)|abre.*email.*(rouba|estranh)|injeta|coisa estranha na tela/i, padrao: "dangerouslySetInnerHTML|innerHTML|v-html|makeHtml" },
]

const BONUS_SMELL = 4 // boost aditivo pra arquivo que casa o MECANISMO do sintoma (calibrado no eval grátis)

/**
 * Combina locator lexical (IDF + match estrutural) com o dicionário de smells. Quem casa MECANISMO E
 * sintoma sobe ao topo (sinal duplo = alta confiança); arquivo só-mecanismo entra como candidato com
 * score base (pega o caso de sintoma enganoso, em que a causa mora num arquivo que o léxico não acha).
 * Tudo determinístico — sem modelo. É o ranking que faltava pra o smell virar candidato útil (top-k).
 */
export async function localizarComSmell(
  raiz: string,
  indice: Indice,
  sintoma: string,
  termos: string[],
  maxFallback = 5,
): Promise<Candidato[]> {
  const lexical = await ranquearCandidatos(raiz, indice, termos)
  const scoreLex = new Map(lexical.map((c) => [c.arquivo, c.score]))
  // Pool ESTREITO do smell (mecanismo), ranqueado por relevância lexical DENTRO do pool (mecanismo +
  // sintoma = topo). Unir a lista lexical inteira afogava (centenas de arquivos); aqui fica ~20.
  // Anota o sinal sistêmico (×N) quando o anti-padrão repete — confiança + indica fix sistêmico.
  const smellRanked = (await localizarPorSmell(raiz, indice, sintoma))
    .map((s) => ({
      arquivo: s.arquivo,
      score: (scoreLex.get(s.arquivo) ?? 0) + BONUS_SMELL,
      estrutural: false,
      termos: [s.sistemico > 1 ? `smell:${s.classe}×${s.sistemico}` : `smell:${s.classe}`],
    }))
    .sort((a, b) => b.score - a.score || a.arquivo.localeCompare(b.arquivo))
  // Fallback: top lexical não-coberto pelo smell (pros casos em que nenhum smell casa, ex. semântica de SDK).
  const vistos = new Set(smellRanked.map((c) => c.arquivo))
  const fallback = lexical.filter((c) => !vistos.has(c.arquivo)).slice(0, maxFallback)
  // Deprioritiza TESTE: arquivo de teste afunda pro fim (nunca é a causa do sintoma de produção). Conserta
  // o caso real medido — o locator lexical surfava MutexTest.kt no topo em vez de Mutex.kt.
  return [...smellRanked, ...fallback].sort(
    (a, b) => (ehArquivoDeTeste(a.arquivo) ? 1 : 0) - (ehArquivoDeTeste(b.arquivo) ? 1 : 0),
  )
}

/** Quais smells o RELATO ativa (intent match). Puro, testável — separa o elo frágil (frase) do grep. */
export function smellsAtivos(sintoma: string): Smell[] {
  return SMELLS.filter((s) => s.intencao.test(sintoma))
}

/**
 * Candidatos por anti-padrão: pros smells que o sintoma ativa, grepa o PADRÃO de código e devolve os
 * arquivos com hit. Zero modelo. Surge o arquivo do MECANISMO mesmo quando o léxico do ticket não casa
 * (ex.: "não terminaram" → grep TODO → o controller-stub). Dedup, com teto por smell.
 */
const HITS_POR_GREP = 80 // teto de HITS por grep; alto pra um arquivo cheio do padrão não engolir as vagas

export async function localizarPorSmell(
  raiz: string,
  indice: Indice,
  sintoma: string,
  maxArquivos = 20,
): Promise<{ arquivo: string; classe: string; sistemico: number }[]> {
  const bruto: { arquivo: string; classe: string }[] = []
  const vistos = new Set<string>()
  for (const s of smellsAtivos(sintoma)) {
    // dedup por ARQUIVO (não por hit); pula TESTE; gate por LINGUAGEM (padrão só vale na extensão certa).
    for (const h of await grep(raiz, indice, s.padrao, HITS_POR_GREP)) {
      if (s.langs && !s.langs.includes(extDe(h.arquivo))) continue
      if (vistos.has(h.arquivo) || ehArquivoDeTeste(h.arquivo)) continue
      vistos.add(h.arquivo)
      bruto.push({ arquivo: h.arquivo, classe: s.classe })
      if (bruto.length >= maxArquivos) break
    }
    if (bruto.length >= maxArquivos) break
  }
  // sinal SISTÊMICO: quantos arquivos compartilham a classe (anti-padrão repetido = mais confiável + fix sistêmico).
  const porClasse = new Map<string, number>()
  for (const b of bruto) porClasse.set(b.classe, (porClasse.get(b.classe) ?? 0) + 1)
  return bruto.map((b) => ({ ...b, sistemico: porClasse.get(b.classe) ?? 1 }))
}
