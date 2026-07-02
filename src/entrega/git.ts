import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { RelatorioExecucao } from "../autonomo/tipos"

// Entrega do Devin-mode: transforma o working tree editado pelo executor num PR no GitHub.
// Segurança: o token NUNCA entra em URL, argumento de comando ou log — vai só por env var e é
// entregue ao git via GIT_ASKPASS (script temporário que ecoa a env). API com timeout explícito.

const TIMEOUT_GIT_MS = 60_000
const TIMEOUT_API_MS = 10_000
const MAX_SLUG = 40
const MAX_TITULO = 90
const AUTOR_NOME = "Jade Code"
const AUTOR_EMAIL = "jade@ararahq.com"

/** Slug determinístico de branch: kebab sem acento + hash curto da instrução (retry = mesmo branch). */
export function slugDeBranch(instrucao: string): string {
  const kebab = instrucao
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "")
  const hash = createHash("sha256").update(instrucao).digest("hex").slice(0, 6)
  return `jade/${kebab || "tarefa"}-${hash}`
}

export function mensagemCommit(instrucao: string): string {
  const uma = instrucao.replace(/\s+/g, " ").trim()
  return `jade: ${uma.length > 72 ? `${uma.slice(0, 69)}...` : uma}`
}

export function tituloPR(instrucao: string): string {
  const uma = instrucao.replace(/\s+/g, " ").trim()
  return `[Jade] ${uma.length > MAX_TITULO ? `${uma.slice(0, MAX_TITULO - 3)}...` : uma}`
}

/** Corpo do PR: estado do gate SEM maquiagem — vermelho/sem-gate aparece em destaque pro revisor. */
export function corpoPR(instrucao: string, rel: RelatorioExecucao): string {
  const aviso =
    rel.estado === "verde"
      ? "Build/teste do subprojeto tocado fechou **verde** antes deste PR."
      : rel.estado === "pre-existente"
        ? "A mudança pedida está aplicada. O build ainda não fecha verde, mas **só por falhas que já existiam antes** desta mudança — ela não introduziu nenhuma regressão."
        : rel.estado === "indeterminado"
          ? "A compilação foi corrigida. Há testes falhando, mas o projeto **não compilava antes** desta mudança — não dá pra afirmar se são regressão ou dívida anterior. **Revise:** confirme se essas falhas já existiam."
          : rel.estado === "sem-gate"
          ? "**Atenção:** não havia build/teste determinável pra validar esta mudança — revise com mais cuidado."
          : "**Atenção:** o build NÃO fechou verde por uma falha nova. Este PR é um progresso parcial honesto, não um pronto."
  return [
    `## Tarefa`,
    instrucao.trim(),
    ``,
    `## Estado`,
    aviso,
    ``,
    `## Arquivos`,
    rel.arquivosEditados.map((a) => `- \`${a}\``).join("\n") || "(nenhum)",
    ``,
    `## Relatório da Jade`,
    rel.resposta.trim(),
    ``,
    `---`,
    `_Aberto automaticamente pelo Jade Code (modo autônomo)._`,
  ].join("\n")
}

type ResultadoGit = { code: number; saida: string }

/** Roda git SEM shell (argv direto — nada de interpolação) e sem prompt interativo. */
export async function git(args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<ResultadoGit> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: opts.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => proc.kill(), TIMEOUT_GIT_MS)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timeout)
  return { code, saida: `${stdout}${stderr}`.trim() }
}

/**
 * Executa `fn` com um GIT_ASKPASS temporário que responde usuário/senha a partir da env — o token
 * não aparece em argv nem em ~/.git-credentials. O script é apagado no fim, aconteça o que acontecer.
 */
async function comCredencial<T>(token: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "jade-askpass-"))
  const script = join(dir, "askpass.sh")
  await writeFile(script, `#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token" ;;\n  *) echo "$JADE_GIT_TOKEN" ;;\nesac\n`)
  await chmod(script, 0o700)
  try {
    return await fn({ GIT_ASKPASS: script, JADE_GIT_TOKEN: token })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function cloneRaso(repoUrl: string, destino: string, token: string, branchBase?: string): Promise<ResultadoGit> {
  return comCredencial(token, (env) =>
    git(["clone", "--depth", "50", ...(branchBase ? ["--branch", branchBase] : []), repoUrl, destino], { cwd: tmpdir(), env }),
  )
}

export async function prepararBranch(branch: string, cwd: string): Promise<ResultadoGit> {
  return git(["checkout", "-B", branch], { cwd })
}

export async function commitarTudo(mensagem: string, cwd: string): Promise<ResultadoGit> {
  const add = await git(["add", "-A"], { cwd })
  if (add.code !== 0) return add
  return git(["-c", `user.name=${AUTOR_NOME}`, "-c", `user.email=${AUTOR_EMAIL}`, "commit", "-m", mensagem], { cwd })
}

export async function pushBranch(branch: string, cwd: string, token: string): Promise<ResultadoGit> {
  return comCredencial(token, (env) => git(["push", "-u", "origin", branch], { cwd, env }))
}

export type ResultadoPR = { ok: true; url: string } | { ok: false; erro: string }

/** Abre o PR via API do GitHub. Timeout explícito; erro volta estruturado e sem vazar o token. */
export async function abrirPR(opts: {
  repo: string // "owner/nome"
  base: string
  head: string
  titulo: string
  corpo: string
  token: string
}): Promise<ResultadoPR> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${opts.repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "jade-code",
      },
      body: JSON.stringify({ title: opts.titulo, body: opts.corpo, head: opts.head, base: opts.base }),
      signal: AbortSignal.timeout(TIMEOUT_API_MS),
    })
    if (resp.status === 201) {
      const pr = (await resp.json()) as { html_url?: unknown }
      if (typeof pr.html_url !== "string") return { ok: false, erro: "resposta da API sem html_url" }
      return { ok: true, url: pr.html_url }
    }
    // 422 com "A pull request already exists" = retry idempotente (mesmo branch determinístico)
    const corpoErro = (await resp.text()).slice(0, 400)
    if (resp.status === 422 && corpoErro.includes("already exists")) {
      return { ok: false, erro: `PR já existe pro branch ${opts.head} (retry idempotente)` }
    }
    return { ok: false, erro: `GitHub API ${resp.status}: ${corpoErro}` }
  } catch (e) {
    return { ok: false, erro: `falha ao chamar a API do GitHub: ${(e as Error).message}` }
  }
}

export type ResultadoEntrega = { ok: true; branch: string; prUrl: string } | { ok: false; passo: string; erro: string }

/**
 * Entrega completa: branch -> commit -> push -> PR. Para no primeiro passo que falhar e devolve
 * QUAL passo falhou (estado parcial explícito — nunca engole nem finge sucesso).
 */
export async function entregarPR(opts: {
  cwd: string
  repo: string
  base: string
  instrucao: string
  relatorio: RelatorioExecucao
  token: string
}): Promise<ResultadoEntrega> {
  const branch = slugDeBranch(opts.instrucao)
  const b = await prepararBranch(branch, opts.cwd)
  if (b.code !== 0) return { ok: false, passo: "branch", erro: b.saida }
  const c = await commitarTudo(mensagemCommit(opts.instrucao), opts.cwd)
  if (c.code !== 0) return { ok: false, passo: "commit", erro: c.saida }
  const p = await pushBranch(branch, opts.cwd, opts.token)
  if (p.code !== 0) return { ok: false, passo: "push", erro: p.saida }
  const pr = await abrirPR({
    repo: opts.repo,
    base: opts.base,
    head: branch,
    titulo: tituloPR(opts.instrucao),
    corpo: corpoPR(opts.instrucao, opts.relatorio),
    token: opts.token,
  })
  if (!pr.ok) return { ok: false, passo: "pr", erro: pr.erro }
  return { ok: true, branch, prUrl: pr.url }
}
