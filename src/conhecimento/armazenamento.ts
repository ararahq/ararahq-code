import { arquivoIndice, garantirDirIndice } from "./paths"

export async function lerJson<T>(raiz: string, nome: string, padrao: T): Promise<T> {
  try {
    const f = Bun.file(arquivoIndice(raiz, nome))
    if (!(await f.exists())) return padrao
    return (await f.json()) as T
  } catch {
    return padrao
  }
}

export async function gravarJson(raiz: string, nome: string, dados: unknown): Promise<void> {
  try {
    await garantirDirIndice(raiz)
    await Bun.write(arquivoIndice(raiz, nome), JSON.stringify(dados))
  } catch {

  }
}
