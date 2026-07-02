import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DriverSandbox } from "./despachante"

const IMAGEM_PADRAO = "jade-sandbox"
const TIMEOUT_SANDBOX_MS = 30 * 60_000

export function criarDriverDocker(env: Record<string, string | undefined>): DriverSandbox {
  const imagem = env.JADE_SANDBOX_IMAGEM ?? IMAGEM_PADRAO
  return {
    nome: "docker",
    async executar(envVars) {
      const dir = await mkdtemp(join(tmpdir(), "jade-envfile-"))
      const envFile = join(dir, "sandbox.env")
      await writeFile(envFile, Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join("\n"))
      await chmod(envFile, 0o600)
      try {
        const proc = Bun.spawn(["docker", "run", "--rm", "--env-file", envFile, "--add-host", "host.docker.internal:host-gateway", imagem], {
          stdout: "pipe",
          stderr: "pipe",
        })
        const timeout = setTimeout(() => proc.kill(), TIMEOUT_SANDBOX_MS)
        const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
        clearTimeout(timeout)

        if (code !== 0 && code !== 1) return { ok: false, erro: `docker exit ${code}: ${stderr.slice(-400)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, erro: (e as Error).message }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}
