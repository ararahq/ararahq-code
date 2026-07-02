import { readdir } from "node:fs/promises"
import { relative } from "node:path"
import { DIRS_IGNORADOS } from "./walk"

export type Subprojeto = {
  caminho: string
  linguagens: string[]
  buildSystem: string
  buildCmd: string | null
  testCmd: string | null
  lintCmd: string | null
}

export type ProjectInfo = {
  raiz: string
  monorepo: boolean
  linguagens: string[]
  buildCmd: string | null
  testCmd: string | null
  lintCmd: string | null
  subprojetos: Subprojeto[]
  desconhecido: boolean
  estrutura: string[]
}

type Manifesto = {
  arquivo: string
  linguagens: string[]
  buildSystem: string
  resolver: (dir: string) => Promise<Omit<Subprojeto, "caminho">>
}

const NODE_PM_LOCK: [string, string][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
]

async function gerenciadorNode(dir: string): Promise<string> {
  for (const [lock, pm] of NODE_PM_LOCK) {
    if (await existe(dir, lock)) return pm
  }
  return "npm"
}

const SCRIPT_BUILD = ["build", "compile"]
const SCRIPT_TEST = ["test", "test:unit", "tests"]
const SCRIPT_LINT = ["lint", "typecheck", "eslint"]

function primeiroScript(scripts: Record<string, unknown>, candidatos: string[]): string | null {
  for (const c of candidatos) {
    if (typeof scripts[c] === "string") return c
  }
  return null
}

async function resolverNode(dir: string): Promise<Omit<Subprojeto, "caminho">> {
  const pm = await gerenciadorNode(dir)
  let scripts: Record<string, unknown> = {}
  let linguagens = ["JavaScript"]
  try {
    const pkg = (await Bun.file(`${dir}/package.json`).json()) as {
      scripts?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
      dependencies?: Record<string, unknown>
    }
    scripts = pkg.scripts ?? {}
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (deps.typescript || (await existe(dir, "tsconfig.json"))) linguagens = ["TypeScript"]
    if (deps.next || deps.react) linguagens = linguagens.includes("TypeScript") ? ["TypeScript", "React"] : ["JavaScript", "React"]
  } catch {

  }
  const run = (s: string) => `${pm} run ${s}`
  const build = primeiroScript(scripts, SCRIPT_BUILD)
  const test = primeiroScript(scripts, SCRIPT_TEST)
  const lint = primeiroScript(scripts, SCRIPT_LINT)
  return {
    linguagens,
    buildSystem: pm,
    buildCmd: build ? run(build) : null,
    testCmd: test ? run(test) : null,
    lintCmd: lint ? run(lint) : null,
  }
}

async function resolverGradle(dir: string): Promise<Omit<Subprojeto, "caminho">> {
  const wrapper = (await existe(dir, "gradlew")) ? "./gradlew" : "gradle"
  const kts = await existe(dir, "build.gradle.kts")
  return {
    linguagens: kts ? ["Kotlin"] : ["Java", "Kotlin"],
    buildSystem: "gradle",
    buildCmd: `${wrapper} build`,
    testCmd: `${wrapper} test`,
    lintCmd: kts ? `${wrapper} detekt ktlintCheck` : `${wrapper} check`,
  }
}

async function resolverMaven(dir: string): Promise<Omit<Subprojeto, "caminho">> {
  const wrapper = (await existe(dir, "mvnw")) ? "./mvnw" : "mvn"
  return {
    linguagens: ["Java"],
    buildSystem: "maven",
    buildCmd: `${wrapper} -q package -DskipTests`,
    testCmd: `${wrapper} -q test`,
    lintCmd: `${wrapper} -q verify`,
  }
}

export function alvosDeMakefile(conteudo: string): Set<string> {
  const alvos = new Set<string>()
  for (const linha of conteudo.split("\n")) {
    const m = linha.match(/^([A-Za-z_][\w-]*)\s*:(?!=)/)
    if (m) alvos.add(m[1])
  }
  return alvos
}

async function linguagemC(dir: string): Promise<string[]> {
  try {
    const nomes = await readdir(dir)
    if (nomes.some((n) => /\.(cpp|cc|cxx|hpp|hh)$/.test(n))) return ["C++"]
    if (nomes.some((n) => /\.(c|h)$/.test(n))) return ["C"]
  } catch {}
  return ["C", "C++"]
}

async function resolverMakefile(dir: string): Promise<Omit<Subprojeto, "caminho">> {
  let alvos = new Set<string>()
  try {
    alvos = alvosDeMakefile(await Bun.file(`${dir}/Makefile`).text())
  } catch {}
  const testCmd = alvos.has("test") ? "make test" : alvos.has("check") ? "make check" : null
  return {
    linguagens: await linguagemC(dir),
    buildSystem: "make",
    buildCmd: "make",
    testCmd,
    lintCmd: null,
  }
}

async function resolverCMake(dir: string): Promise<Omit<Subprojeto, "caminho">> {
  return {
    linguagens: await linguagemC(dir),
    buildSystem: "cmake",
    buildCmd: "cmake -S . -B build && cmake --build build",
    testCmd: "ctest --test-dir build --output-on-failure",
    lintCmd: null,
  }
}

function estatico(
  linguagens: string[],
  buildSystem: string,
  buildCmd: string | null,
  testCmd: string | null,
  lintCmd: string | null,
): (dir: string) => Promise<Omit<Subprojeto, "caminho">> {
  return async () => ({ linguagens, buildSystem, buildCmd, testCmd, lintCmd })
}

const MANIFESTOS: Manifesto[] = [
  { arquivo: "package.json", linguagens: ["JavaScript"], buildSystem: "node", resolver: resolverNode },
  { arquivo: "build.gradle.kts", linguagens: ["Kotlin"], buildSystem: "gradle", resolver: resolverGradle },
  { arquivo: "build.gradle", linguagens: ["Java", "Kotlin"], buildSystem: "gradle", resolver: resolverGradle },
  { arquivo: "settings.gradle.kts", linguagens: ["Kotlin"], buildSystem: "gradle", resolver: resolverGradle },
  { arquivo: "settings.gradle", linguagens: ["Java"], buildSystem: "gradle", resolver: resolverGradle },
  { arquivo: "pom.xml", linguagens: ["Java"], buildSystem: "maven", resolver: resolverMaven },
  {
    arquivo: "Cargo.toml", linguagens: ["Rust"], buildSystem: "cargo",
    resolver: estatico(["Rust"], "cargo", "cargo build", "cargo test", "cargo clippy"),
  },
  {
    arquivo: "go.mod", linguagens: ["Go"], buildSystem: "go",
    resolver: estatico(["Go"], "go", "go build ./...", "go test ./...", "go vet ./..."),
  },
  {
    arquivo: "pyproject.toml", linguagens: ["Python"], buildSystem: "python",
    resolver: estatico(["Python"], "pyproject", "python -m build", "pytest", "ruff check ."),
  },
  {
    arquivo: "requirements.txt", linguagens: ["Python"], buildSystem: "pip",
    resolver: estatico(["Python"], "pip", null, "pytest", "ruff check ."),
  },
  {
    arquivo: "composer.json", linguagens: ["PHP"], buildSystem: "composer",
    resolver: estatico(["PHP"], "composer", "composer install", "composer test", "composer lint"),
  },
  {
    arquivo: "Gemfile", linguagens: ["Ruby"], buildSystem: "bundler",
    resolver: estatico(["Ruby"], "bundler", "bundle install", "bundle exec rspec", "bundle exec rubocop"),
  },
  {
    arquivo: "Package.swift", linguagens: ["Swift"], buildSystem: "swiftpm",
    resolver: estatico(["Swift"], "swiftpm", "swift build", "swift test", null),
  },

  { arquivo: "CMakeLists.txt", linguagens: ["C++"], buildSystem: "cmake", resolver: resolverCMake },
  { arquivo: "Makefile", linguagens: ["C"], buildSystem: "make", resolver: resolverMakefile },
]

async function existe(dir: string, arq: string): Promise<boolean> {
  try {
    return await Bun.file(`${dir}/${arq}`).exists()
  } catch {
    return false
  }
}

async function temCsproj(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).some((n) => n.endsWith(".csproj"))
  } catch {
    return false
  }
}

async function detectarDir(raiz: string, dir: string): Promise<Subprojeto | null> {
  for (const m of MANIFESTOS) {
    if (await existe(dir, m.arquivo)) {
      const r = await m.resolver(dir)
      return { caminho: relative(raiz, dir) || ".", ...r }
    }
  }
  if (await temCsproj(dir)) {
    return {
      caminho: relative(raiz, dir) || ".",
      linguagens: ["C#"],
      buildSystem: "dotnet",
      buildCmd: "dotnet build",
      testCmd: "dotnet test",
      lintCmd: "dotnet format --verify-no-changes",
    }
  }
  return null
}

const MAX_SUBNIVEL = 2

async function descobrirSubprojetos(raiz: string): Promise<Subprojeto[]> {
  const achados: Subprojeto[] = []
  const visitar = async (dir: string, nivel: number): Promise<void> => {
    if (nivel > MAX_SUBNIVEL) return
    let entradas
    try {
      entradas = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entradas) {
      if (!e.isDirectory() || DIRS_IGNORADOS.has(e.name) || e.name.startsWith(".")) continue
      const abs = `${dir}/${e.name}`
      const sub = await detectarDir(raiz, abs)
      if (sub) achados.push(sub)
      else await visitar(abs, nivel + 1)
    }
  }
  await visitar(raiz, 1)
  return achados
}

export async function detectarStack(raiz: string): Promise<ProjectInfo> {
  const naRaiz = await detectarDir(raiz, raiz)
  const subprojetos = await descobrirSubprojetos(raiz)

  if (naRaiz && !subprojetos.length) {
    return {
      raiz,
      monorepo: false,
      linguagens: naRaiz.linguagens,
      buildCmd: naRaiz.buildCmd,
      testCmd: naRaiz.testCmd,
      lintCmd: naRaiz.lintCmd,
      subprojetos: [naRaiz],
      desconhecido: false,
      estrutura: [naRaiz.caminho],
    }
  }

  const todos = naRaiz ? [naRaiz, ...subprojetos] : subprojetos
  if (todos.length) {
    const linguagens = [...new Set(todos.flatMap((s) => s.linguagens))]
    const principal = naRaiz ?? todos[0]
    return {
      raiz,
      monorepo: subprojetos.length > 0,
      linguagens,
      buildCmd: principal.buildCmd,
      testCmd: principal.testCmd,
      lintCmd: principal.lintCmd,
      subprojetos: todos,
      desconhecido: false,
      estrutura: todos.map((s) => s.caminho).sort(),
    }
  }

  return {
    raiz,
    monorepo: false,
    linguagens: [],
    buildCmd: null,
    testCmd: null,
    lintCmd: null,
    subprojetos: [],
    desconhecido: true,
    estrutura: [],
  }
}
