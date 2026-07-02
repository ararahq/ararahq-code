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

  tamanho(): number {
    return pilha.length
  },

  async reverterAte(marca: number): Promise<void> {
    while (pilha.length > marca) await this.reverter()
  },
}
