// 3.4 — Test-time compute: gera N candidatos e seleciona por VERIFICAÇÃO (não por confiança do modelo).
//
// A geração é PARALELA (cada candidato é uma passada de raciocínio sobre o MESMO material já reunido —
// sem efeito colateral, então paralelizar é seguro e corta latência). A verificação é SERIAL: aplicar
// o fix de um candidato mexe no disco (editar + build), e dois candidatos editando ao mesmo tempo
// corromperiam a árvore. Roda cada candidato, build pela Camada 4; o PRIMEIRO que fecha verde ganha,
// os perdedores são revertidos. Multiplica o custo — por isso só entra no diagnóstico difícil que a 1ª
// passada não cravou. Orquestração pura: gerar/verificar/reverter são injetados (testável sem modelo/build).

export type ResultadoSelecao<T> = {
  vencedor: T | null
  gerados: number
  verificados: number
}

/**
 * Gera `n` candidatos em paralelo e seleciona o primeiro que passa na verificação, revertendo os que
 * falham antes de tentar o próximo. `gerar(i)` pode devolver null (candidato inválido — descartado).
 * Para no primeiro verde: os candidatos seguintes nem são verificados (não foram aplicados, nada a
 * reverter neles). Devolve o vencedor (ou null) + contagem de gerados/verificados pra métrica.
 */
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
