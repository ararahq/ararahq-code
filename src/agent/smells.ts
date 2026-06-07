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

export type Smell = { classe: string; intencao: RegExp; padrao: string }

export const SMELLS: Smell[] = [
  { classe: "stub", intencao: /n[ãa]o? termin|inacab|pela metade|nem (feito|fizeram|terminaram)|incomplet|n[ãa]o (foi|ta) (feito|pronto)/i, padrao: "TODO\\(|not yet impl|notimplementederror|FIXME\\b" },
  { classe: "dedup", intencao: /pessoa errada|destinat[aá]ri|trocou (o|a)|foi pra (outr|quem)|mensagem.*(errad|trocad)/i, padrao: "distinctBy|associateBy|groupBy|\\.toMap\\(|dedup" },
  { classe: "error-class", intencao: /culpa.*client|sempre.*(erro|falh)|n[ãa]o.*(retent|tenta de novo)|trata.*erro.*errad/i, padrao: "statusCode|\\bit\\.code\\b|CLIENT_ERROR|SERVER_ERROR|getOrElse" },
  { classe: "fail-open-auth", intencao: /sem senha|senha em branco|qualquer um (entra|acessa|passa)|sem (credencial|autentic)|libera(do)? sem/i, padrao: "process\\.env\\.[A-Z_]*(PASS|USER|SECRET|TOKEN)|verify\\s*=\\s*false|===\\s*process\\.env" },
  { classe: "timing-compare", intencao: /forj(ar|a|am)|se passar (por|como)|assinatura (fraca|falsa|burl)|d[áa] pra (passar|forjar|fingir|burlar)|seguran[çc]a (falou|disse|achou)|burlar|spoofar/i, padrao: "(signature|hmac|verifytoken|verify_token|digest|secret)\\s*(==|!=)|\\.equals\\([^)]*(signature|hmac|token|secret)" },
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
  const smellRanked = (await localizarPorSmell(raiz, indice, sintoma))
    .map((s) => ({ arquivo: s.arquivo, score: (scoreLex.get(s.arquivo) ?? 0) + BONUS_SMELL, estrutural: false, termos: [`smell:${s.classe}`] }))
    .sort((a, b) => b.score - a.score || a.arquivo.localeCompare(b.arquivo))
  // Fallback: top lexical não-coberto pelo smell (pros casos em que nenhum smell casa, ex. semântica de SDK).
  const vistos = new Set(smellRanked.map((c) => c.arquivo))
  const fallback = lexical.filter((c) => !vistos.has(c.arquivo)).slice(0, maxFallback)
  return [...smellRanked, ...fallback]
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
): Promise<{ arquivo: string; classe: string }[]> {
  const out: { arquivo: string; classe: string }[] = []
  const vistos = new Set<string>()
  for (const s of smellsAtivos(sintoma)) {
    // dedup por ARQUIVO (não por hit): um arquivo com 20 TODOs não pode crowd-out os outros candidatos.
    for (const h of await grep(raiz, indice, s.padrao, HITS_POR_GREP)) {
      if (vistos.has(h.arquivo)) continue
      vistos.add(h.arquivo)
      out.push({ arquivo: h.arquivo, classe: s.classe })
      if (out.length >= maxArquivos) return out
    }
  }
  return out
}
