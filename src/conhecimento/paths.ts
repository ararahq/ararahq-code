import { mkdir } from "node:fs/promises"
import { hashRaiz } from "../context/projeto"

export function dirIndice(raiz: string): string {
  return `${process.env.HOME}/.arara/projects/${hashRaiz(raiz)}/index`
}

export function arquivoIndice(raiz: string, nome: string): string {
  return `${dirIndice(raiz)}/${nome}`
}

export async function garantirDirIndice(raiz: string): Promise<void> {
  await mkdir(dirIndice(raiz), { recursive: true })
}
