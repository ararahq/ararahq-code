import { resumoExtrativo } from "../engine/marques"
import type { ResumirFn } from "../conhecimento/resumos"

// 1.4 — Resumo por arquivo pelo Marques EXTRATIVO (TCC): zero token, determinístico. Substitui o
// resumo via modelo barato — a "assinatura semântica" do arquivo (termos mais salientes) é o que o
// mapa e o índice de retrieval precisam, e sai de graça. Cacheado por hash via gerarResumos.
const MAX_TERMOS = 12

/**
 * Cria a `ResumirFn` (1.4) extrativa. Nunca null — não depende de API key (não gasta token). Devolve
 * os termos mais frequentes do arquivo, que casam o sintoma do usuário melhor que assinatura crua.
 */
export function criarResumirFn(): ResumirFn {
  return async (_arquivo, conteudo) => resumoExtrativo(conteudo, MAX_TERMOS).join(", ")
}
