export type ResultadoSelecao<T> = {
  vencedor: T | null
  gerados: number
  verificados: number
}

export async function selecionarPorVerificacao<T>(
  n: number,
  gerar: (indice: number) => Promise<T | null>,
  verificar: (candidato: T) => Promise<boolean>,
  reverter: (candidato: T) => Promise<void>,
): Promise<ResultadoSelecao<T>> {
  if (n <= 0) return { vencedor: null, gerados: 0, verificados: 0 }

  const brutos = await Promise.all(Array.from({ length: n }, (_, i) => gerar(i).catch(() => null)))
  const gerados: T[] = []
  for (const c of brutos) if (c != null) gerados.push(c)

  let verificados = 0
  for (const candidato of gerados) {
    verificados++
    if (await verificar(candidato)) {
      return { vencedor: candidato, gerados: gerados.length, verificados }
    }
    await reverter(candidato)
  }
  return { vencedor: null, gerados: gerados.length, verificados }
}
