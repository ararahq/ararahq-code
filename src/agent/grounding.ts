import { extrairLocaisErro } from "./erros"

// Grounding determinístico: "olha antes de decidir". Antes de qualquer plano de modelo, roda o sinal
// barato e concreto que ANCORA o problema — e para tarefa "faça o build/teste passar", esse sinal é
// rodar o próprio build e ler o arquivo:linha que o compilador aponta. Foi o degrau que faltava: no
// teste real, o Maestro decompôs a frase crua no ESCURO (v4-flash alucinou "não tenho acesso ao
// código") e o diagnóstico ancorou no NOME do tipo (twilioService -> TwilioService) em vez do teste
// que não compila. Com o build rodado antes, o material chega mastigado e o modelo não adivinha.

// Detecção de intenção "conserta o build/teste": precisa de um ALVO (test/build/compilação) E de uma
// AÇÃO (passar/consertar/falhando). Determinístico, sem modelo. Cobre PT e EN comuns.
const RE_ALVO = /\b(test|teste|testes|tests|build|compil\w*|su[íi]te|suite|ci|gradle|maven|pipeline)\b/i
const RE_ACAO = /\b(pass\w*|verde|green|conserta\w*|corrig\w*|arrum\w*|fix\w*|falha\w*|fail\w*|quebrad\w*|n[ãa]o\s+(passa|compila)|red)\b/i

export function pareceConsertarBuild(input: string): boolean {
  return RE_ALVO.test(input) && RE_ACAO.test(input)
}

export type LocalTrecho = { arquivo: string; linha: number; trecho: string | null }

/** Tarefa mastigada com os locais exatos apontados pelo compilador. Pura, testável. */
export function montarTarefaAterrada(input: string, locais: LocalTrecho[]): string {
  const lista = locais.map((l) => `- ${l.arquivo}:${l.linha}`).join("\n")
  const trechos = locais
    .filter((l) => l.trecho)
    .map((l) => `### ${l.arquivo}:${l.linha}\n${l.trecho}`)
    .join("\n\n")
  return (
    `Pedido do usuário: ${input}\n\n` +
    `Eu JÁ rodei o build/teste do projeto. Ele FALHOU, e o compilador aponta o erro EXATAMENTE nestes locais:\n` +
    `${lista}\n\n` +
    (trechos ? `Trechos desses pontos:\n\n${trechos}\n\n` : "") +
    `Conserte o erro NESSES arquivos:linha e rode o gate pra confirmar verde. ` +
    `Um erro num arquivo de TESTE se conserta no próprio teste, não no serviço de produção que ele exercita. ` +
    `NÃO decomponha em plano genérico nem investigue outros arquivos de nome parecido — o local já está apontado; vá direto ao conserto.`
  )
}

export type DepsAterramento = {
  raiz: string
  comando: string | null // comando de teste/build do projeto (Camada 1); null = sem gate determinável
  rodar: (comando: string) => Promise<{ code: number; saida: string }>
  lerTrecho: (arquivo: string, linha: number) => Promise<string | null>
}

export type Aterramento =
  | { tipo: "ja-verde" }
  | { tipo: "aterrado"; tarefa: string; arquivos: string[] }

/**
 * Roda o gate UMA vez e aterra a tarefa nos locais do erro. Devolve:
 * - `ja-verde`: o build já passa (nada a consertar) — quem chama responde honesto e sai.
 * - `aterrado`: build falhou com locais claros -> tarefa mastigada + arquivos pro escopo.
 * - `null`: sem comando determinável, ou erro SEM local extraível (aí o diagnóstico normal assume —
 *   não força um caminho que não tem âncora). Paths normalizados pra relativos à raiz.
 */
export async function aterrarPorBuild(input: string, deps: DepsAterramento): Promise<Aterramento | null> {
  if (!deps.comando) return null
  const { code, saida } = await deps.rodar(deps.comando)
  if (code === 0) return { tipo: "ja-verde" }
  const locais = extrairLocaisErro(saida)
  if (!locais.length) return null
  const prefixo = `${deps.raiz.replace(/\/$/, "")}/`
  const arquivos = new Set<string>()
  const comTrecho: LocalTrecho[] = []
  for (const l of locais) {
    const rel = l.arquivo.startsWith(prefixo) ? l.arquivo.slice(prefixo.length) : l.arquivo
    arquivos.add(rel)
    comTrecho.push({ arquivo: rel, linha: l.linha, trecho: await deps.lerTrecho(rel, l.linha) })
  }
  return { tipo: "aterrado", tarefa: montarTarefaAterrada(input, comTrecho), arquivos: [...arquivos] }
}
