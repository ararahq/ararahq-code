import { tool } from "ai"
import { z } from "zod"
import { readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { dicaLocaisErro } from "../agent/erros"
import { ui } from "../terminal/ui"
import { pathSeguro, sanitizar } from "../security/sanitize"
import { Backup } from "./backup"
import { registrarFalha, resetRecovery, TETO_RECOVERY } from "../agent/recovery"
import { resetBaseline } from "../agent/baseline"
import {
  resetCamada4,
  escopoAtual,
  dentroDoEscopo,
  avisoForaDoEscopo,
  registrarCandidatoForaEscopo,
  registrarEdicao,
  edicaoRepetida,
  contradizEdicaoAnterior,
  acaoRepetida,
  contornoAmbiente,
} from "../agent/camada4"

const MAX_LINHAS = 400
const MAX_SAIDA = 6000
const MAX_BUSCAS = 5
const MAX_LEITURAS = 8

const BLOQUEIOS: RegExp[] = [
  /rm\s+-[a-z]*r[a-z]*f/i,
  /\bsudo\b/i,
  /(curl|wget)[^\n|]*\|\s*(sh|bash|zsh)/i,
  /chmod\s+-?R?\s*777/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\//i,
  />\s*\/sys\//i,
]

const IGNORAR = new Set([
  ".git", "node_modules", "build", "bin", ".gradle", "dist", "out", "target", ".next", "vendor",
  "pgdata", ".github", ".idea", ".vscode", "coverage", ".venv", "__pycache__", ".smithery",
])

// Autônomo por padrão. Confirma só o que é destrutivo/irreversível/externo.
const PERIGOSOS: RegExp[] = [
  /git\s+push/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-[a-z]*f/i,
  /git\s+checkout\s+(\.|--)/i,
  /git\s+restore\b/i,
  /\brm\s+-[a-z]*r/i,
]

const _rodada = new Set<string>()
const _lidos = new Set<string>()
let _recovery = 0
let _buscas = 0
let _leituras = 0
// Contorno de ambiente (4.2) tentado nesta rodada — só UMA vez por rodada, pra não empilhar prefixo.
let _contornoTentado = false
export function novaRodada() {
  _rodada.clear()
  _lidos.clear()
  _recovery = 0
  _buscas = 0
  _leituras = 0
  _contornoTentado = false
  resetRecovery()
  resetCamada4()
  resetBaseline()
}

function contar(texto: string, alvo: string): number {
  if (!alvo) return 0
  return texto.split(alvo).length - 1
}

async function arvore(dir: string, prefixo: string, prof: number, acc: string[], cap: { n: number }) {
  if (prof < 0 || cap.n >= 300) return
  let entradas
  try {
    entradas = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const filtradas = entradas
    .filter((e) => !IGNORAR.has(e.name) && !e.name.startsWith("."))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
  for (const e of filtradas) {
    if (cap.n >= 300) {
      acc.push(`${prefixo}...`)
      return
    }
    acc.push(`${prefixo}${e.name}${e.isDirectory() ? "/" : ""}`)
    cap.n++
    if (e.isDirectory()) await arvore(`${dir}/${e.name}`, `${prefixo}  `, prof - 1, acc, cap)
  }
}

const TIMEOUT_PADRAO = 180_000
const TIMEOUT_LONGO = 600_000
const GRACA_KILL = 3_000
const COMANDOS_LONGOS = /\b(gradlew|gradle|mvn|maven|cargo|make|cmake|ctest|go\s+(build|test)|(npm|yarn|pnpm|bun)\s+(run\s+)?(build|test|ci))\b/

function timeoutDe(comando: string): number {
  return COMANDOS_LONGOS.test(comando) ? TIMEOUT_LONGO : TIMEOUT_PADRAO
}

function recortar(saida: string): string {
  if (saida.length <= MAX_SAIDA) return saida.trim()
  const meio = Math.floor(MAX_SAIDA / 2)
  return `${saida.slice(0, meio).trim()}\n…\n${saida.slice(-meio).trim()}`
}

/**
 * Roda o comando em process group próprio e transmite a saída ao vivo.
 * No timeout, mata o grupo inteiro (SIGTERM -> SIGKILL) — pega o daemon do gradle junto —
 * e resolve mesmo que o pipe não feche, então nunca trava o agente.
 */
export function rodar(
  comando: string,
  onLinha?: (l: string) => void,
  timeoutMs = timeoutDe(comando),
  signal?: AbortSignal,
): Promise<{ code: number; saida: string; expirou: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-lc", comando], { cwd: process.cwd(), detached: true })
    let saida = ""
    let buffer = ""
    let resolvido = false
    let expirou = false
    let sigkill: ReturnType<typeof setTimeout> | null = null

    const matar = (sig: "SIGTERM" | "SIGKILL") => {
      try {
        if (proc.pid) process.kill(-proc.pid, sig)
      } catch {
        try {
          proc.kill(sig)
        } catch {}
      }
    }
    const concluir = (code: number) => {
      if (resolvido) return
      resolvido = true
      clearTimeout(limite)
      if (sigkill) clearTimeout(sigkill)
      const resto = buffer.replace(/\s+$/, "")
      if (resto && onLinha) onLinha(resto)
      resolve({ code: expirou ? 124 : code, saida: recortar(saida), expirou })
    }
    const limite = setTimeout(() => {
      expirou = true
      matar("SIGTERM")
      sigkill = setTimeout(() => matar("SIGKILL"), GRACA_KILL)
      setTimeout(() => concluir(124), GRACA_KILL + 500)
    }, timeoutMs)

    const consumir = (chunk: Buffer | string) => {
      const txt = chunk.toString()
      if (saida.length < MAX_SAIDA * 50) saida += txt
      if (!onLinha) return
      buffer += txt
      let idx: number
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const linha = buffer.slice(0, idx).replace(/\s+$/, "")
        buffer = buffer.slice(idx + 1)
        if (linha) onLinha(linha)
      }
    }
    proc.stdout?.on("data", consumir)
    proc.stderr?.on("data", consumir)
    proc.on("close", (code: number | null) => concluir(code ?? 0))
    proc.on("error", () => concluir(127))

    if (signal) {
      const aoCancelar = () => {
        matar("SIGTERM")
        if (sigkill) clearTimeout(sigkill)
        sigkill = setTimeout(() => matar("SIGKILL"), GRACA_KILL)
        concluir(130)
      }
      if (signal.aborted) aoCancelar()
      else signal.addEventListener("abort", aoCancelar, { once: true })
    }
  })
}

const DIRS_IGNORADOS = [...IGNORAR, "dumps"]
// Arquivos de dados/gerados que poluem a busca (dumps SQL, lockfiles, minificados, backups).
const ARQUIVOS_RUIDO = ["*.sql", "*.lock", "*.lockb", "*.min.js", "*.map", "*.snap", "*.csv", "backup*"]
const EXCLUI_DIRS = `{${DIRS_IGNORADOS.join(",")}}`
// rg não expande brace em glob ('!**/{a,b}/**' não funciona); precisa de um -g por diretório/arquivo.
const RG_GLOBS = [
  ...DIRS_IGNORADOS.map((d) => `-g '!${d}/'`),
  ...ARQUIVOS_RUIDO.map((a) => `-g '!${a}'`),
].join(" ")
const GREP_EXCLUI_ARQ = ARQUIVOS_RUIDO.map((a) => `--exclude='${a}'`).join(" ")
// Pro dossiê de diagnóstico: só código-fonte de verdade, sem teste/lock/json/bundle.
const FONTE_EXTS = ["kt", "kts", "ts", "tsx", "js", "jsx", "java", "py", "go", "rs", "php", "rb", "c", "h", "cpp", "cc", "hpp", "cs", "swift"]
const RG_FONTE = FONTE_EXTS.map((e) => `-g '*.${e}'`).join(" ")
const RG_NAO_TESTE = ["-g '!*.test.*'", "-g '!*.spec.*'", "-g '!*Test.*'", "-g '!*Tests.*'", "-g '!**/test/**'", "-g '!**/tests/**'", "-g '!**/__tests__/**'"].join(" ")
const GREP_FONTE = FONTE_EXTS.map((e) => `--include='*.${e}'`).join(" ")
const TEM_RG = Boolean(Bun.which("rg"))

/** Busca por regex de verdade (alternância com |, .*, classes). Exclui dirs e arquivos de ruído (dumps/locks/sql). */
export function comandoBusca(query: string): string {
  const q = query.replace(/'/g, "'\\''")
  if (TEM_RG) {
    return `rg --line-number --no-heading --color=never --smart-case --max-count=3 ${RG_GLOBS} -e '${q}' . 2>/dev/null | head -40`
  }
  return `grep -rniIE --max-count=3 --exclude-dir=${EXCLUI_DIRS} ${GREP_EXCLUI_ARQ} -e '${q}' . 2>/dev/null | head -40`
}

/** Conta hits por arquivo pra rankear relevância (dossiê de diagnóstico). Saída "arquivo:N" ordenada desc. */
export function comandoContagem(query: string): string {
  const q = query.replace(/'/g, "'\\''")
  if (TEM_RG) {
    return `rg --count-matches --no-heading --color=never --smart-case ${RG_GLOBS} ${RG_FONTE} ${RG_NAO_TESTE} -e '${q}' . 2>/dev/null | sort -t: -k2 -rn | head -20`
  }
  return `grep -rcIE --exclude-dir=${EXCLUI_DIRS} ${GREP_EXCLUI_ARQ} ${GREP_FONTE} --exclude='*Test*' --exclude='*test*' --exclude='*spec*' -e '${q}' . 2>/dev/null | grep -v ':0$' | sort -t: -k2 -rn | head -20`
}

const RE_VERIFICACAO =
  /\b(gradlew|gradle|mvn|maven|cargo|make|cmake|ctest|dotnet\s+(build|test)|go\s+(build|test|vet)|(npm|yarn|pnpm|bun)\s+(run\s+)?(build|test|lint|typecheck|ci)|tsc|eslint|ktlint|detekt|pytest|jest|vitest|rspec|phpunit)\b/i
const MAX_RECOVERY = 4

export function ehVerificacao(comando: string): boolean {
  return RE_VERIFICACAO.test(comando)
}

/** Empurra o agente a consertar e re-rodar até verde, com teto pra não entrar em loop. */
export function sufixoRecovery(tentativa: number): string {
  if (tentativa <= MAX_RECOVERY) {
    return `\n\n--- FALHOU (tentativa ${tentativa}/${MAX_RECOVERY}). Decida a ORIGEM:\n• Erro do SEU código (compilação/tipo no que editou) → corrija o ponto exato e rode de novo.\n• Erro de AMBIENTE (versão de runtime — Java/Node/Python/Go/Rust — ou ferramenta/dependência faltando) → NÃO fique caçando com find/grep/sed. Confirma que teu código está certo, diz ao usuário qual runtime/ferramenta instalar (na versão exigida) e PARA.`
  }
  return `\n\n--- Ainda falhando após ${MAX_RECOVERY} tentativas. PARE. Se é ambiente/infra (não sua mudança), diga claro ao usuário com o passo pra resolver. Não fique tentando.`
}

export const ferramentas = {
  ler_arquivo: tool({
    description: "Lê o conteúdo de um arquivo do projeto. Sempre leia antes de editar.",
    inputSchema: z.object({ caminho: z.string().describe("caminho relativo à raiz do projeto") }),
    execute: async ({ caminho }) => {
      const f = pathSeguro(caminho)
      if (!f) return `caminho fora do projeto ou bloqueado: ${caminho}`
      if (_lidos.has(caminho)) return `Você já leu ${caminho} nesta tarefa. Use o conteúdo que já tem; não releia.`
      if (_leituras >= MAX_LEITURAS)
        return `Limite de leituras desta tarefa atingido. PARE de explorar e responda com diagnóstico (arquivo:linha) e conserto, usando o que já leu.`
      if (!(await Bun.file(f).exists())) return `arquivo não encontrado: ${caminho}`
      _lidos.add(caminho)
      _leituras++
      const todas = (await Bun.file(f).text()).split("\n")
      const linhas = todas.slice(0, MAX_LINHAS)
      ui.toolAcao("ler_arquivo", `${caminho} (${linhas.length} linhas)`)
      const numeradas = sanitizar(linhas.join("\n"))
        .split("\n")
        .map((l, i) => `${i + 1}\t${l}`)
        .join("\n")
      const aviso =
        todas.length > MAX_LINHAS
          ? `\n\n[truncado: ${MAX_LINHAS} de ${todas.length} linhas. Veja o resto com rodar_comando: sed -n '${MAX_LINHAS + 1},${MAX_LINHAS * 2}p' ${caminho}]`
          : ""
      return `${caminho}:\n\n${numeradas}${aviso}`
    },
  }),

  listar_arquivos: tool({
    description: "Lista arquivos e pastas. Por padrão mostra só o nível atual; passe 'profundidade' para descer mais.",
    inputSchema: z.object({
      caminho: z.string().optional().describe("diretório relativo (padrão: raiz)"),
      profundidade: z.number().optional().describe("níveis a descer (padrão: 1)"),
    }),
    execute: async ({ caminho, profundidade }) => {
      const base = pathSeguro(caminho ?? ".")
      if (!base) return `caminho fora do projeto: ${caminho}`
      const chave = `listar:${caminho ?? "."}`
      if (_rodada.has(chave)) return "Você já listou esse diretório nesta tarefa. Use o resultado anterior, não repita."
      _rodada.add(chave)
      ui.toolAcao("listar_arquivos", caminho ?? ".")
      const acc: string[] = []
      await arvore(base, "", Math.max(1, Math.min(profundidade ?? 1, 4)) - 1, acc, { n: 0 })
      return acc.join("\n") || "(vazio)"
    },
  }),

  buscar_no_projeto: tool({
    description:
      "Busca por regex em todo o projeto (ripgrep/grep -E). Suporta alternância com | (ex: 'shared|dedicated|isShared'), " +
      ".* e classes de caractere. Use para LOCALIZAR onde algo é definido, salvo ou usado antes de ler. " +
      "Não adivinhe caminhos: busque.",
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      const chave = `buscar:${query}`
      if (_rodada.has(chave)) return "Você já buscou isso nesta tarefa. Use o resultado anterior."
      if (_buscas >= MAX_BUSCAS)
        return `Limite de buscas desta tarefa atingido. PARE de buscar; leia o arquivo de serviço/entidade mais provável e responda com o que já tem.`
      _rodada.add(chave)
      _buscas++
      ui.toolAcao("buscar_no_projeto", query)
      const { saida } = await rodar(comandoBusca(query), undefined, 15_000)
      return saida || `sem resultados para "${query}". Tente outro termo, ou liste o diretório provável e leia o arquivo direto.`
    },
  }),

  editar_arquivo: tool({
    description:
      "Edita um arquivo via âncora: localiza um bloco EXATO ('ancora') e o substitui por 'novo'. " +
      "A âncora precisa existir exatamente uma vez. Para criar um arquivo, deixe 'ancora' vazia.",
    inputSchema: z.object({
      caminho: z.string(),
      ancora: z.string().optional().describe("bloco exato atual a substituir (vazio = criar arquivo)"),
      novo: z.string().describe("conteúdo que substitui a âncora"),
      motivo: z.string().describe("por que essa mudança"),
    }),
    execute: async ({ caminho, ancora, novo, motivo }) => {
      const f = pathSeguro(caminho)
      if (!f) return `caminho fora do projeto ou bloqueado: ${caminho}`
      const escopo = escopoAtual()
      if (!dentroDoEscopo(escopo, caminho)) {
        registrarCandidatoForaEscopo(caminho)
        return avisoForaDoEscopo(escopo, caminho)
      }
      if (edicaoRepetida(caminho, ancora, novo))
        return `Você já fez exatamente esta edição em ${caminho} nesta tarefa. Não repita — verifique o resultado (rode o build) em vez de reeditar igual.`
      if (contradizEdicaoAnterior(caminho, ancora, novo))
        return `Essa edição DESFAZ uma mudança que você acabou de fazer em ${caminho} (flip-flop). Pare de oscilar: decida o valor certo de uma vez. Se realmente precisa reverter, explique o porquê ao usuário antes — não fique alternando.`
      const existe = await Bun.file(f).exists()
      let novoConteudo: string
      let removido = ""
      if (existe) {
        const atual = await Bun.file(f).text()
        if (!ancora || !ancora.trim()) return "arquivo já existe — 'ancora' é obrigatória (sem reescrita cega)"
        const n = contar(atual, ancora)
        if (n === 0) return `âncora não encontrada em ${caminho}`
        if (n > 1) return `âncora ambígua em ${caminho}: ${n} ocorrências. Inclua mais contexto.`
        const idx = atual.indexOf(ancora)
        novoConteudo = atual.slice(0, idx) + novo + atual.slice(idx + ancora.length)
        removido = ancora
      } else {
        novoConteudo = novo
      }
      ui.toolAcao("editar_arquivo", caminho)
      ui.motivo(motivo)
      ui.diff(removido, novo)
      Backup.registrar(f, existe ? await Bun.file(f).text() : null)
      await Bun.write(f, novoConteudo)
      registrarEdicao(caminho, ancora ?? "", novo)
      return `${existe ? "editado" : "criado"}: ${caminho} (${novoConteudo.split("\n").length} linhas)`
    },
  }),

  rodar_comando: tool({
    description:
      "Executa um comando no terminal do projeto e transmite a saída ao vivo. " +
      "Use para compilar, testar e verificar. Tem timeout: builds longos não travam o agente.",
    inputSchema: z.object({ comando: z.string(), motivo: z.string() }),
    execute: async ({ comando, motivo }, opts) => {
      if (BLOQUEIOS.some((r) => r.test(comando))) return `comando bloqueado por segurança: ${comando}`
      // Trava de JAVA_HOME chutado: o contorno de ambiente é resolvido por `/usr/libexec/java_home`
      // (contornoAmbiente). Se o modelo improvisa um caminho literal que NÃO existe (o caso real:
      // `/usr/local/opt/openjdk@17`), não gasta 40s num build fadado — devolve na hora e reorienta.
      const mJava = comando.match(/\bJAVA_HOME=(["']?)(\/[^"'\s&|;$]+)\1/)
      if (mJava && !existsSync(mJava[2]))
        return `JAVA_HOME chutado: "${mJava[2]}" não existe nesta máquina. NÃO adivinhe caminho de runtime — o ambiente Java é resolvido automaticamente, então rode o build direto (ex.: ./gradlew ...) sem exportar JAVA_HOME. Se faltar um JDK de fato, diga qual versão instalar e pare.`
      // 4.3 — ação repetida: o MESMO comando não-verificação já rodou nesta tarefa. Build/teste fica
      // de fora (re-rodar após conserto é legítimo); um `ls`/`cat`/`find` repetido é loop sem progresso.
      if (!ehVerificacao(comando) && acaoRepetida("rodar_comando", comando))
        return `Você já rodou exatamente "${comando}" nesta tarefa e não é build/teste. Use o resultado anterior — não repita a mesma ação, avance pro próximo passo.`
      ui.toolAcao("rodar_comando", comando)
      if (PERIGOSOS.some((r) => r.test(comando))) {
        ui.motivo(motivo)
        if (!(await ui.confirmar("Executar? (destrutivo/externo)"))) return `usuário cancelou: ${comando}`
      }

      let { code, saida, expirou, seg } = await executarComando(comando, opts?.abortSignal)
      if (expirou) {
        ui.toolResultado(`timeout em ${seg}s — processo encerrado`)
        return `[timeout ${seg}s] o comando passou do limite e foi morto. Saída parcial:\n${saida}`
      }
      ui.toolResultado(`exit ${code} · ${(saida ? saida.split("\n").length : 0)} linha(s) · ${seg}s`)

      // 4.2 — degrau de ambiente: build falhou por runtime/toolchain incompatível (Java, Node,
      // Python, Go, Rust...) ou ferramenta faltando? Classifica como ambiente, tenta UM contorno
      // determinístico e, se não resolver, DEVOLVE honesto — em vez de virar loop de find/grep/sed.
      if (code !== 0 && ehVerificacao(comando) && !_contornoTentado) {
        const amb = contornoAmbiente(comando, saida)
        if (amb) {
          _contornoTentado = true
          if (amb.reexecutar) {
            ui.linhaComando("ambiente: runtime incompatível — tentando contorno…")
            ui.toolAcao("rodar_comando", amb.reexecutar)
            const r2 = await executarComando(amb.reexecutar, opts?.abortSignal)
            ui.toolResultado(`exit ${r2.code} · ${(r2.saida ? r2.saida.split("\n").length : 0)} linha(s) · ${r2.seg}s`)
            if (r2.code === 0) return `[exit 0] (contorno de ambiente aplicado: ${amb.reexecutar})\n${r2.saida}`
            return `[exit ${r2.code}]\n${r2.saida}\n\n--- ${amb.mensagem}`
          }
          return `[exit ${code}]\n${saida}\n\n--- ${amb.mensagem}`
        }
      }

      let sufixo = ""
      if (code !== 0 && ehVerificacao(comando)) {
        // Ancoragem no local exato do erro (grep grátis): antes de qualquer conselho, diz ONDE o
        // compilador apontou — mata o "erro no teste vira edição no serviço de nome parecido".
        sufixo += dicaLocaisErro(saida)
        const r = registrarFalha(saida)
        sufixo += r.estourou
          ? `\n\n--- TETO de ${TETO_RECOVERY} tentativas de recuperação atingido. PARE de tentar. Resuma ao usuário: o que tentou, o que descobriu (causa raiz com arquivo:linha se já achou) e onde travou. Se for ambiente/infra, diga o passo pra resolver (ex.: instalar o runtime na versão certa).`
          : sufixoRecovery(++_recovery)
      }
      return `[exit ${code}]\n${saida}${sufixo}`
    },
  }),
}

type ResultadoComando = { code: number; saida: string; expirou: boolean; seg: string }

/** Executa um comando com streaming na tela (cap de linhas) e devolve resultado + tempo. Reusável pro contorno. */
async function executarComando(comando: string, signal?: AbortSignal): Promise<ResultadoComando> {
  const inicio = Date.now()
  let mostradas = 0
  const { code, saida, expirou } = await rodar(
    comando,
    (l) => {
      if (mostradas < 30) ui.linhaComando(l.slice(0, 200))
      else if (mostradas === 30) ui.linhaComando("… (resto da saída omitido da tela; o agente recebe tudo)")
      mostradas++
    },
    undefined,
    signal,
  )
  return { code, saida, expirou, seg: ((Date.now() - inicio) / 1000).toFixed(1) }
}
