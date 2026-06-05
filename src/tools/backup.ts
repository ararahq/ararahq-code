import { unlink } from "node:fs/promises"

type Entrada = { path: string; antigo: string | null }

const pilha: Entrada[] = []

export const Backup = {
  registrar(path: string, antigo: string | null) {
    pilha.push({ path, antigo })
  },
  async reverter(): Promise<string | null> {
    const b = pilha.pop()
    if (!b) return null
    if (b.antigo === null) {
      try {
        await unlink(b.path)
      } catch {}
    } else {
      await Bun.write(b.path, b.antigo)
    }
    return b.path
  },
  /** Tamanho atual da pilha — vira um checkpoint pra reverter ATÉ aqui (3.4 test-time compute). */
  tamanho(): number {
    return pilha.length
  },
  /** Reverte (LIFO) até a pilha voltar ao tamanho `marca`. Desfaz as edições de um candidato perdedor. */
  async reverterAte(marca: number): Promise<void> {
    while (pilha.length > marca) await this.reverter()
  },
}
