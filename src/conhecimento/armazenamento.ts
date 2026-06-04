import { arquivoIndice, garantirDirIndice } from "./paths"

/**
 * Lê um JSON do índice, tolerante a ausência e corrupção: retorna `padrao` se o arquivo não existe
 * ou está malformado, nunca crasha. A persistência do índice é auxiliar — falha de leitura degrada
 * pra reindexação, não derruba o app.
 */
export async function lerJson<T>(raiz: string, nome: string, padrao: T): Promise<T> {
  try {
    const f = Bun.file(arquivoIndice(raiz, nome))
    if (!(await f.exists())) return padrao
    return (await f.json()) as T
  } catch {
    return padrao
  }
}

/** Grava um JSON no índice criando o diretório se preciso. Falha silenciosa: nunca derruba a tarefa. */
export async function gravarJson(raiz: string, nome: string, dados: unknown): Promise<void> {
  try {
    await garantirDirIndice(raiz)
    await Bun.write(arquivoIndice(raiz, nome), JSON.stringify(dados))
  } catch {
    // Persistência auxiliar: não propaga.
  }
}
