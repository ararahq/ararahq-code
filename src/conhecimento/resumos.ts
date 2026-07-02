import { lerJson, gravarJson } from "./armazenamento"

const ARQUIVO = "resumos.json"

export type Resumo = { resumo: string; hash: string }
export type CacheResumos = Record<string, Resumo>

export type ResumirFn = (arquivo: string, conteudo: string) => Promise<string>

export async function carregarResumos(raiz: string): Promise<CacheResumos> {
  return lerJson<CacheResumos>(raiz, ARQUIVO, {})
}

export async function salvarResumos(raiz: string, cache: CacheResumos): Promise<void> {
  await gravarJson(raiz, ARQUIVO, cache)
}

export type AlvoResumo = { arquivo: string; hash: string; conteudo: string }

export async function gerarResumos(
  raiz: string,
  alvos: AlvoResumo[],
  modelFn: ResumirFn | null,
  concorrencia = 4,
): Promise<CacheResumos> {
  const cache = await carregarResumos(raiz)
  if (!modelFn) return cache

  const pendentes = alvos.filter((a) => cache[a.arquivo]?.hash !== a.hash)
  for (let i = 0; i < pendentes.length; i += concorrencia) {
    const lote = pendentes.slice(i, i + concorrencia)
    const resultados = await Promise.all(
      lote.map(async (a) => {
        try {
          const resumo = (await modelFn(a.arquivo, a.conteudo)).trim()
          return { arquivo: a.arquivo, resumo, hash: a.hash }
        } catch {
          return null
        }
      }),
    )
    for (const r of resultados) {
      if (r && r.resumo) cache[r.arquivo] = { resumo: r.resumo, hash: r.hash }
    }
  }
  await salvarResumos(raiz, cache)
  return cache
}
