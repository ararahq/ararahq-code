import { mkdir } from "node:fs/promises"
import { hashRaiz } from "../context/projeto"

/** Diretório raiz do índice de conhecimento de um projeto, derivado do hash da raiz. */
export function dirIndice(raiz: string): string {
  return `${process.env.HOME}/.arara/projects/${hashRaiz(raiz)}/index`
}

/** Caminho de um arquivo de persistência do índice (project.json, simbolos.json, etc). */
export function arquivoIndice(raiz: string, nome: string): string {
  return `${dirIndice(raiz)}/${nome}`
}

/** Garante que o diretório do índice existe. Idempotente. */
export async function garantirDirIndice(raiz: string): Promise<void> {
  await mkdir(dirIndice(raiz), { recursive: true })
}
