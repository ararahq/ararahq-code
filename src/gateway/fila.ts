import { Database } from "bun:sqlite"
import type { RefResposta, TarefaNormalizada } from "../autonomo/tipos"

export type EstadoFila = "pendente" | "rodando" | "concluida" | "falhou"

export type TarefaFila = TarefaNormalizada & { id: number; estado: EstadoFila }

type Linha = {
  id: number
  dedupe_key: string
  origem: string
  repo: string | null
  instrucao: string
  autor: string
  resposta_ref: string
  estado: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tarefas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  origem TEXT NOT NULL,
  repo TEXT,
  instrucao TEXT NOT NULL,
  autor TEXT NOT NULL,
  resposta_ref TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendente',
  resultado TEXT,
  criada_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizada_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tarefas_estado ON tarefas(estado);
`

export class Fila {
  private db: Database

  constructor(caminho = process.env.JADE_FILA_DB ?? "jade-fila.sqlite") {
    this.db = new Database(caminho, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec(SCHEMA)
  }

  enfileirar(t: TarefaNormalizada): boolean {
    const r = this.db.run(
      `INSERT OR IGNORE INTO tarefas (dedupe_key, origem, repo, instrucao, autor, resposta_ref)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [t.dedupeKey, t.origem, t.repo, t.instrucao, t.autor, JSON.stringify(t.resposta)],
    )
    return r.changes > 0
  }

  proxima(): TarefaFila | null {
    const linha = this.db
      .query<Linha, []>(
        `UPDATE tarefas SET estado = 'rodando', atualizada_em = datetime('now')
         WHERE id = (SELECT id FROM tarefas WHERE estado = 'pendente' ORDER BY id LIMIT 1)
         RETURNING id, dedupe_key, origem, repo, instrucao, autor, resposta_ref, estado`,
      )
      .get()
    return linha ? deLinha(linha) : null
  }

  concluir(id: number, estado: "concluida" | "falhou", resultado: string): void {
    this.db.run(`UPDATE tarefas SET estado = ?, resultado = ?, atualizada_em = datetime('now') WHERE id = ?`, [
      estado,
      resultado,
      id,
    ])
  }

  buscar(id: number): TarefaFila | null {
    const linha = this.db
      .query<Linha, [number]>(
        `SELECT id, dedupe_key, origem, repo, instrucao, autor, resposta_ref, estado FROM tarefas WHERE id = ?`,
      )
      .get(id)
    return linha ? deLinha(linha) : null
  }

  pendentes(): number {
    const r = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tarefas WHERE estado = 'pendente'`).get()
    return r?.n ?? 0
  }

  fechar(): void {
    this.db.close()
  }
}

function deLinha(l: Linha): TarefaFila {
  return {
    id: l.id,
    dedupeKey: l.dedupe_key,
    origem: l.origem as TarefaFila["origem"],
    repo: l.repo,
    instrucao: l.instrucao,
    autor: l.autor,
    resposta: JSON.parse(l.resposta_ref) as RefResposta,
    estado: l.estado as EstadoFila,
  }
}
