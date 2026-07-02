import { extrairLocaisErro } from "./erros"

const RE_ALVO = /\b(test|teste|testes|tests|build|compil\w*|su[íi]te|suite|ci|gradle|maven|pipeline)\b/i
const RE_ACAO = /\b(pass\w*|verde|green|conserta\w*|corrig\w*|arrum\w*|fix\w*|falha\w*|fail\w*|quebrad\w*|n[ãa]o\s+(passa|compila)|red)\b/i

export function pareceConsertarBuild(input: string): boolean {
  return RE_ALVO.test(input) && RE_ACAO.test(input)
}

const RE_DEPRECIACAO = /\bdeprecia\w*|\bdeprecat\w*|\bwarning\w*|\bavisos?\b|\bobsolet\w*/i

export function pareceConsertarDepreciacao(input: string): boolean {
  return RE_DEPRECIACAO.test(input) && RE_ACAO.test(input)
}

export type LocalTrecho = { arquivo: string; linha: number; trecho: string | null }

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
  comando: string | null
  rodar: (comando: string) => Promise<{ code: number; saida: string }>
  lerTrecho: (arquivo: string, linha: number) => Promise<string | null>
}

export type Aterramento =
  | { tipo: "ja-verde" }

  | { tipo: "aterrado"; tarefa: string; arquivos: string[]; saida: string }

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
  return { tipo: "aterrado", tarefa: montarTarefaAterrada(input, comTrecho), arquivos: [...arquivos], saida }
}
