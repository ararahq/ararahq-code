import { describe, expect, test } from "bun:test"
import { montarEnvSandbox } from "./despachante"
import type { TarefaFila } from "../gateway/fila"

const tarefa = (repo: string | null): TarefaFila => ({
  id: 7,
  dedupeKey: "wa:1",
  origem: "whatsapp",
  repo,
  instrucao: "conserta o bug",
  autor: "551199",
  resposta: { origem: "whatsapp", para: "551199" },
  estado: "rodando",
})

const ENV_OK = {
  JADE_GIT_TOKEN: "ghp_x",
  OPENROUTER_API_KEY: "sk-or-y",
  JADE_CALLBACK_URL: "http://gw/interno/resultado",
  JADE_CALLBACK_SECRET: "seg",
}

describe("montarEnvSandbox", () => {
  test("tarefa com repo próprio monta a env completa", () => {
    const r = montarEnvSandbox(tarefa("ararahq/api"), ENV_OK)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.parse(r.vars.JADE_TAREFA_JSON)).toEqual({ id: 7, repo: "ararahq/api", instrucao: "conserta o bug" })
      expect(r.vars.JADE_GIT_TOKEN).toBe("ghp_x")
      expect(r.vars.JADE_BRANCH_BASE).toBe("main")
    }
  })

  test("sem repo na tarefa cai no JADE_REPO_PADRAO", () => {
    const r = montarEnvSandbox(tarefa(null), { ...ENV_OK, JADE_REPO_PADRAO: "ararahq/mono" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(JSON.parse(r.vars.JADE_TAREFA_JSON).repo).toBe("ararahq/mono")
  })

  test("sem repo resolvível ou sem credencial recusa com motivo — não sobe sandbox mudo", () => {
    const semRepo = montarEnvSandbox(tarefa(null), ENV_OK)
    expect(semRepo.ok).toBe(false)
    if (!semRepo.ok) expect(semRepo.motivo).toContain("repositório")
    const semGit = montarEnvSandbox(tarefa("a/b"), { ...ENV_OK, JADE_GIT_TOKEN: undefined })
    expect(semGit.ok).toBe(false)
    const semLLM = montarEnvSandbox(tarefa("a/b"), { ...ENV_OK, OPENROUTER_API_KEY: undefined })
    expect(semLLM.ok).toBe(false)
  })
})
