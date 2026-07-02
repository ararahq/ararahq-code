import type { Indice } from "../conhecimento"
import { grep, ranquearCandidatos, type Candidato } from "./navegacao"

export type Smell = { classe: string; intencao: RegExp; padrao: string; langs?: string[] }

export function ehArquivoDeTeste(caminho: string): boolean {
  return /(^|\/)(tests?|specs?|__tests__|__mocks__)(\/|$)|\.(test|spec)\.[a-z]+$|(Test|Tests|Spec|IT)\.[A-Za-z]+$/.test(caminho)
}

export function extDe(caminho: string): string {
  const i = caminho.lastIndexOf(".")
  return i < 0 ? "" : caminho.slice(i + 1).toLowerCase()
}

export const SMELLS: Smell[] = [

  { classe: "stub", intencao: /n[ãa]o? termin|inacab|pela metade|nem (feito|fizeram|terminaram)|incomplet|n[ãa]o (foi|ta) (feito|pronto)/i, padrao: "TODO\\(|not yet impl|notimplementederror|raise NotImplemented|throw.{0,20}NotImplemented" },
  { classe: "dedup", intencao: /pessoa errada|destinat[aá]ri|trocou (o|a)|foi pra (outr|quem)|mensagem.*(errad|trocad)/i, padrao: "distinctBy|associateBy|groupBy|\\.toMap\\(|dedup" },
  { classe: "error-class", intencao: /culpa.*client|sempre.*(erro|falh)|n[ãa]o.*(retent|tenta de novo)|trata.*erro.*errad/i, padrao: "statusCode|\\bit\\.code\\b|CLIENT_ERROR|SERVER_ERROR|getOrElse" },
  { classe: "fail-open-auth", intencao: /sem senha|senha em branco|qualquer um (entra|acessa|passa)|sem (credencial|autentic)|libera(do)? sem/i, padrao: "process\\.env\\.[A-Z_]*(PASS|USER|SECRET|TOKEN)|verify\\s*=\\s*false|===\\s*process\\.env" },

  { classe: "timing-compare", intencao: /forj(ar|a|am)|se passar (por|como)|assinatura (fraca|falsa|burl)|d[áa] pra (passar|forjar|fingir|burlar)|seguran[çc]a (falou|disse|achou)|burlar|spoofar/i, padrao: "(signature|hmac|verifytoken|verify_token|digest)\\s*(==|!=)\\s*(?!null)|(?<!Objects)\\.equals\\([^)]*(signature|hmac|token|secret)" },

  { classe: "eq-java", langs: ["java"], intencao: /condi[çc][ãa]o.*(nunca|n[ãa]o).*(pega|bate|funciona|entra)|compara[çc][ãa]o.*(errad|n[ãa]o funciona)|nunca (entra|cai|é verdadeir)|string.*(compar|igual)/i, padrao: "[\\w)\\]]\\s*(==|!=)\\s*\"" },

  { classe: "eq-python", langs: ["py"], intencao: /condi[çc][ãa]o.*(nunca|n[ãa]o).*(pega|bate|funciona|entra)|compara[çc][ãa]o.*(errad|n[ãa]o funciona)|nunca (entra|cai|é verdadeir)/i, padrao: "\\bis\\s+[\"'\\d]" },

  { classe: "cors-wildcard", intencao: /qualquer (site|origem|lugar|um de fora)|cross.?site|\bcors\b|de qualquer (origem|lugar)|origem.*liberad|hijack/i, padrao: "(allowedorigins?|allow-origin|cross.?origin|setallowedorigin)[^\\n]{0,25}[\"']\\*[\"']" },
  { classe: "lock", intencao: /duas vezes|duplicad?|repetid|mesma (mensagem|coisa).*(vez|duas)|v[áa]rios servidor|ao mesmo tempo|concorr/i, padrao: "setIfAbsent|setnx|\\bMutex\\b|\\block\\b|synchronized|setExpiration" },
  { classe: "lost-msg", intencao: /some(m|u)?|sumi|evapor|n[ãa]o (chega|recebe|recebeu)|perde(u|ndo)|nunca tenta de novo/i, padrao: "deletionPolicy|ALWAYS|catch\\s*\\(|\\back\\b|acknowledge|sys\\.exit" },
  { classe: "stuck-ttl", intencao: /trava.*(sempre|pra sempre)|nunca volta|bloquead.*sempre|n[ãa]o volta nem reinic/i, padrao: "setIfAbsent|\\bexpire\\b|setTtl|setExpiration|EXPIRE" },
  { classe: "pii-leak", intencao: /(cpf|telefone|dados?).*(link|p[úu]blic|sem senha)|vazou|abriu.*(arquivo|csv).*sem/i, padrao: "PublicRead|public-read|CannedAccessControlList|setPublic|ACL" },
  { classe: "ssrf", intencao: /servidor.*(busca|baixa|alcan).*(qualquer|o que mand|interno)|laranja|de fora.*nosso servidor/i, padrao: "requests\\.get|fetch\\(|RestTemplate|HttpClient|urlopen" },
  { classe: "xss", intencao: /tela.*(estranh|coisa)|abre.*email.*(rouba|estranh)|injeta|coisa estranha na tela/i, padrao: "dangerouslySetInnerHTML|innerHTML|v-html|makeHtml" },
]

const BONUS_SMELL = 4

export async function localizarComSmell(
  raiz: string,
  indice: Indice,
  sintoma: string,
  termos: string[],
  maxFallback = 5,
): Promise<Candidato[]> {
  const lexical = await ranquearCandidatos(raiz, indice, termos)
  const scoreLex = new Map(lexical.map((c) => [c.arquivo, c.score]))

  const smellRanked = (await localizarPorSmell(raiz, indice, sintoma))
    .map((s) => ({
      arquivo: s.arquivo,
      score: (scoreLex.get(s.arquivo) ?? 0) + BONUS_SMELL,
      estrutural: false,
      termos: [s.sistemico > 1 ? `smell:${s.classe}×${s.sistemico}` : `smell:${s.classe}`],
    }))
    .sort((a, b) => b.score - a.score || a.arquivo.localeCompare(b.arquivo))

  const vistos = new Set(smellRanked.map((c) => c.arquivo))
  const fallback = lexical.filter((c) => !vistos.has(c.arquivo)).slice(0, maxFallback)

  return [...smellRanked, ...fallback].sort(
    (a, b) => (ehArquivoDeTeste(a.arquivo) ? 1 : 0) - (ehArquivoDeTeste(b.arquivo) ? 1 : 0),
  )
}

export function smellsAtivos(sintoma: string): Smell[] {
  return SMELLS.filter((s) => s.intencao.test(sintoma))
}

const HITS_POR_GREP = 80

export async function localizarPorSmell(
  raiz: string,
  indice: Indice,
  sintoma: string,
  maxArquivos = 20,
): Promise<{ arquivo: string; classe: string; sistemico: number }[]> {
  const bruto: { arquivo: string; classe: string }[] = []
  const vistos = new Set<string>()
  for (const s of smellsAtivos(sintoma)) {

    for (const h of await grep(raiz, indice, s.padrao, HITS_POR_GREP)) {
      if (s.langs && !s.langs.includes(extDe(h.arquivo))) continue
      if (vistos.has(h.arquivo) || ehArquivoDeTeste(h.arquivo)) continue
      vistos.add(h.arquivo)
      bruto.push({ arquivo: h.arquivo, classe: s.classe })
      if (bruto.length >= maxArquivos) break
    }
    if (bruto.length >= maxArquivos) break
  }

  const porClasse = new Map<string, number>()
  for (const b of bruto) porClasse.set(b.classe, (porClasse.get(b.classe) ?? 0) + 1)
  return bruto.map((b) => ({ ...b, sistemico: porClasse.get(b.classe) ?? 1 }))
}
