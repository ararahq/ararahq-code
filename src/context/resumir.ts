import { resumoExtrativo } from "../engine/marques"
import type { ResumirFn } from "../conhecimento/resumos"

const MAX_TERMOS = 12

export function criarResumirFn(): ResumirFn {
  return async (_arquivo, conteudo) => resumoExtrativo(conteudo, MAX_TERMOS).join(", ")
}
