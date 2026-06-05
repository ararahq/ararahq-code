// Camada 4 — Verificação e Recuperação. Travas que impedem as 3 falhas reais do run com key:
// (1) scope creep — editar fora do que o diagnóstico mandou; (2) seguir editando com build
// vermelho; (3) erro de ambiente (Java incompatível) não contornado. Funções puras + um estado
// de escopo/edições por-rodada, setado no início da Fase 2 e checado dentro de editar_arquivo.

import type { ProjectInfo } from "../conhecimento/stack"
import { extrairArquivosCitados } from "../engine/refcodigo"
import { detectarContradicao, type Edicao } from "../engine/marques"

// --- 4.3-ESCOPO: extração do escopo permitido do diagnóstico mastigado -------

/** Normaliza pra comparação: tira `./` inicial e a parte `:linha`, mantém o caminho do arquivo. */
function normalizarArquivo(bruto: string): string {
  return bruto.replace(/^\.\//, "").replace(/:\d+.*$/, "").trim()
}

export type Escopo = {
  arquivos: Set<string>
  // base names (sem diretório) — o diagnóstico pode citar `MessageService.kt` e a edição vir com
  // o caminho completo `src/main/kotlin/.../MessageService.kt`. Casar pelo base evita falso bloqueio.
  bases: Set<string>
  livre: boolean
}

/**
 * Extrai o ESCOPO permitido de um diagnóstico mastigado: os arquivos citados na CAUSA RAIZ +
 * CORREÇÃO (formato `arquivo:linha` ou `arquivo`). Função pura. Se o texto não citar nenhum
 * arquivo de código, devolve escopo LIVRE (sem trava) — não inventa restrição onde não há alvo.
 */
export function escopoDoDiagnostico(textoMastigado: string): Escopo {
  const arquivos = extrairArquivosCitados(textoMastigado).map(normalizarArquivo).filter(Boolean)
  return montarEscopo([...new Set(arquivos)])
}

/**
 * Escopo a partir de uma lista explícita de arquivos (execução guiada com causa dada pelo
 * usuário: o escopo são os arquivos que ele citou). Lista vazia => modo LIVRE (sem trava).
 */
export function escopoDeArquivos(arquivos: string[]): Escopo {
  return montarEscopo(arquivos.map(normalizarArquivo).filter(Boolean))
}

function montarEscopo(lista: string[]): Escopo {
  const arquivos = new Set(lista)
  const bases = new Set([...arquivos].map((a) => a.split("/").pop() ?? a))
  return { arquivos, bases, livre: arquivos.size === 0 }
}

/**
 * O arquivo a editar está DENTRO do escopo? Casa por caminho exato, por sufixo (o escopo cita o
 * caminho completo e a edição vem com um caminho relativo mais curto, ou vice-versa) ou por base
 * name (mesmo nome de arquivo). Escopo livre libera tudo. Função pura testável.
 */
export function dentroDoEscopo(escopo: Escopo, caminho: string): boolean {
  if (escopo.livre) return true
  const alvo = normalizarArquivo(caminho)
  const base = alvo.split("/").pop() ?? alvo
  if (escopo.arquivos.has(alvo)) return true
  if (escopo.bases.has(base)) return true
  for (const permitido of escopo.arquivos) {
    if (permitido.endsWith(`/${base}`) || alvo.endsWith(`/${permitido}`) || permitido.endsWith(alvo) || alvo.endsWith(permitido)) {
      return true
    }
  }
  return false
}

/**
 * Mensagem injetada quando uma edição fora do escopo é bloqueada. Em vez de mandar editar, manda
 * LISTAR os candidatos e PERGUNTAR ao usuário — cada uso parecido pode ter semântica própria.
 */
export function avisoForaDoEscopo(escopo: Escopo, caminho: string): string {
  const permitidos = [...escopo.arquivos].join(", ")
  return (
    `EDIÇÃO BLOQUEADA: ${caminho} está FORA do que foi diagnosticado/pedido (escopo: ${permitidos}). ` +
    `NÃO corrija por conta própria — um uso parecido pode usar esse comportamento DE PROPÓSITO, e mexer às cegas vira regressão. ` +
    `Em vez de editar: LISTE pro usuário os outros pontos candidatos que você achou (com arquivo:linha) e PERGUNTE se ele quer que você corrija também, ` +
    `avisando que cada um pode ter semântica diferente. Só siga depois da confirmação dele.`
  )
}

// --- estado de escopo + edições por-rodada -----------------------------------
// Um escopo por tarefa, setado no começo da Fase 2 (ou da execução guiada). editar_arquivo
// consulta esse estado. novaRodada() limpa tudo (modo livre por padrão).

type EstadoCamada4 = {
  escopo: Escopo
  editados: Set<string>
  // dedup de edição idêntica: chave caminho|ancora|novo -> barra repetição (4.3-coerência).
  edicoesFeitas: Set<string>
  // arquivos fora-de-escopo que o modelo tentou editar — viram a pergunta "quer que eu corrija também?".
  candidatos: Set<string>
  // 4.3 — histórico das edições aplicadas (pra detectar flip-flop) e das ações já feitas (tool+arg).
  historico: Edicao[]
  acoes: Set<string>
}

const SEM_ESCOPO: Escopo = { arquivos: new Set(), bases: new Set(), livre: true }

function estadoVazio(): EstadoCamada4 {
  return {
    escopo: SEM_ESCOPO,
    editados: new Set(),
    edicoesFeitas: new Set(),
    candidatos: new Set(),
    historico: [],
    acoes: new Set(),
  }
}

let estado: EstadoCamada4 = estadoVazio()

/** Limpa o estado da Camada 4 (chamado por novaRodada). Default: escopo livre, nada editado. */
export function resetCamada4(): void {
  estado = estadoVazio()
}

/** Define o escopo permitido da rodada (início da Fase 2 / execução guiada). */
export function definirEscopo(escopo: Escopo): void {
  estado.escopo = escopo
}

export function escopoAtual(): Escopo {
  return estado.escopo
}

/** Lista (ordenada) dos arquivos já editados nesta rodada — pra reinjetar no prepareStep. */
export function arquivosEditados(): string[] {
  return [...estado.editados].sort()
}

export function registrarEdicao(caminho: string, ancora = "", novo = ""): void {
  const arq = normalizarArquivo(caminho)
  estado.editados.add(arq)
  estado.historico.push({ arquivo: arq, ancora, novo })
}

/**
 * 4.3 — A edição proposta DESFAZ uma já aplicada nesta tarefa (flip-flop X->Y depois Y->X)? Delega
 * pra Marques.detectarContradicao, que já tem a salvaguarda de escopo (arquivos diferentes não
 * conflitam). Repetição idêntica não cai aqui — é o dedup de `edicaoRepetida`.
 */
export function contradizEdicaoAnterior(caminho: string, ancora: string | undefined, novo: string): boolean {
  return detectarContradicao(estado.historico, { arquivo: normalizarArquivo(caminho), ancora: ancora ?? "", novo })
}

/**
 * 4.3 — Ação repetida: a MESMA chamada (tool + argumento) já rolou nesta tarefa? Registra se for nova.
 * Mata o loop de repetir a mesma ação sem progredir. Comandos de verificação (build/test) ficam de
 * fora pelo chamador — re-rodar após um conserto é legítimo.
 */
export function acaoRepetida(tool: string, argumento: string): boolean {
  const k = `${tool}::${argumento}`
  if (estado.acoes.has(k)) return true
  estado.acoes.add(k)
  return false
}

export function houveEdicao(): boolean {
  return estado.editados.size > 0
}

/** Registra um arquivo que o modelo tentou editar fora do escopo — candidato a perguntar ao usuário. */
export function registrarCandidatoForaEscopo(caminho: string): void {
  estado.candidatos.add(normalizarArquivo(caminho))
}

/** Pontos parecidos que ficaram de fora do escopo — pra fechar a rodada perguntando se corrige também. */
export function candidatosForaEscopo(): string[] {
  return [...estado.candidatos].sort()
}

/** Assinatura de uma edição, pra detectar repetição exata (mesma âncora + mesmo novo conteúdo).
 * JSON.stringify de um array dá uma chave sem colisão (os limites entre os 3 campos são inequívocos
 * porque a JSON escapa aspas/especiais) e SEM byte de controle — o delimitador NUL antigo deixava o
 * arquivo binário pro git e pro grep. */
function chaveEdicao(caminho: string, ancora: string, novo: string): string {
  return JSON.stringify([normalizarArquivo(caminho), ancora, novo])
}

/** Já fez ESTA edição idêntica nesta rodada? Registra se for nova. Barra o loop de re-editar igual. */
export function edicaoRepetida(caminho: string, ancora: string | undefined, novo: string): boolean {
  const k = chaveEdicao(caminho, ancora ?? "", novo)
  if (estado.edicoesFeitas.has(k)) return true
  estado.edicoesFeitas.add(k)
  return false
}

// --- 4.1 TEST-GATE -----------------------------------------------------------

/** Toda tarefa que EDITOU código passa pelo portão de build antes de declarar pronto. */
export function precisaTestGate(houveEdicao: boolean): boolean {
  return houveEdicao
}

export type Gate = { build: string; test: string | null; subprojeto: string }

/**
 * Monta o comando do test-gate a partir do project.json (Camada 1): acha o subprojeto que contém
 * o arquivo tocado e usa o buildCmd dele (e testCmd quando barato). Em monorepo, escolhe o
 * subprojeto de caminho mais específico (mais longo) que é prefixo do arquivo. Função pura.
 * Devolve null se não dá pra determinar um build (stack desconhecida) — aí não há portão a aplicar.
 */
export function montarGate(project: ProjectInfo, arquivoTocado: string): Gate | null {
  const arq = normalizarArquivo(arquivoTocado)
  const candidatos = project.subprojetos
    .filter((s) => s.buildCmd)
    .filter((s) => s.caminho === "." || arq === s.caminho || arq.startsWith(`${s.caminho}/`))
    .sort((a, b) => b.caminho.length - a.caminho.length)
  const sub = candidatos[0] ?? project.subprojetos.find((s) => s.buildCmd) ?? null
  if (!sub || !sub.buildCmd) {
    if (!project.buildCmd) return null
    return { build: project.buildCmd, test: null, subprojeto: project.raiz }
  }
  return { build: sub.buildCmd, test: testBarato(sub.testCmd), subprojeto: sub.caminho }
}

// Test suites que tipicamente sobem container/DB (caras) NÃO entram no gate automático — o build
// já pega quebra de compilação, que é o que o scope creep introduz. Roda teste só se for barato.
const TEST_CARO = /\b(gradle|gradlew|mvn|maven|integrationTest|e2e|cypress|playwright)\b/i

function testBarato(testCmd: string | null): string | null {
  if (!testCmd) return null
  return TEST_CARO.test(testCmd) ? null : testCmd
}

/** Comando(s) do gate em ordem: build sempre; teste depois se for barato. */
export function comandosDoGate(gate: Gate): string[] {
  return gate.test ? [gate.build, gate.test] : [gate.build]
}

// Instruções de orquestração interna injetadas no gate. NÃO usam cabeçalho "parrotável" (o modelo
// repetia "PORTÃO VERMELHO" na resposta, vazando a maquinaria) e mandam explicitamente não narrar.

/** Injetada quando o build do gate fica vermelho: conserta ou reverte, nada de edit novo. */
export const INSTRUCAO_GATE_VERMELHO =
  "O build falhou após a tua edição. NÃO faça edição nova fora do conserto. " +
  "Conserte exatamente o que quebrou OU reverta a mudança que causou — e só finalize quando o build ficar verde. " +
  "Se a falha for de ambiente (versão de Java/ferramenta), aplique o contorno de JAVA_HOME ou pare e diga ao usuário. " +
  "Não narre nem repita este aviso na tua resposta ao usuário — só aja."

/** Injetada quando o build do gate fica verde: pode declarar pronto. */
export const INSTRUCAO_GATE_VERDE =
  "O build passou — a correção está consistente. Finalize com um resumo curto ao usuário. Não mencione este aviso."

// --- 4.2 CONTORNO DE AMBIENTE (agnóstico de linguagem) -----------------------
// Build/test falhou por AMBIENTE (runtime/toolchain incompatível, ferramenta faltando) — não por
// código. Cada ecossistema é UMA regra: como detectar no erro, em que comando se aplica, um contorno
// determinístico OPCIONAL (re-rodar com a versão certa) e a instrução honesta pro usuário. Sem
// contorno seguro? Ainda classifica como ambiente e DEVOLVE a instrução — nunca vira loop de
// find/grep/sed. Adicionar uma linguagem = adicionar uma linha em REGRAS_AMBIENTE.

export type AcaoAmbiente = {
  // Comando pra re-rodar UMA vez com o contorno aplicado (ex.: JAVA_HOME prefixado). null = é
  // ambiente, mas não há auto-fix seguro nesta máquina; só resta reportar com honestidade.
  reexecutar: string | null
  // Instrução específica do ecossistema, mostrada quando o contorno falha (ou quando é null).
  mensagem: string
}

type RegraAmbiente = {
  // Sinais INEQUÍVOCOS de ambiente no erro (versão de runtime/toolchain, ferramenta ausente).
  detecta: RegExp
  // Em que comando a regra se aplica (qual ecossistema). Narrowing — deixa `detecta` poder ser largo.
  aplica: RegExp
  // Contorno determinístico: re-roda o MESMO comando apontando pra versão compatível. Opcional.
  contorno?: (comando: string) => string
  // Já está contornado? (evita empilhar prefixo / loop). Só relevante quando há `contorno`.
  jaContornado?: RegExp
  // Instrução honesta pro usuário quando não há contorno (ou ele falhou).
  mensagem: string
}

// Aponta JAVA_HOME pra uma JDK que os build tools atuais aceitam (17/21 LTS). `-v 17` ANTES de
// `-v 21` de propósito: numa máquina sem o 21 exato, `java_home -v 21` cai no Java MAIS NOVO
// instalado (ex.: 25 — justamente o incompatível). `-v 17` pega o 17 exato quando existe e degrada
// pro 21 só se não houver 17. `export` (não `JAVA_HOME=val cmd`): a var precisa valer pra LINHA toda,
// inclusive depois de `cd x &&` — prefixar a atribuição vale só pro primeiro comando (o `cd`).
const JAVA_HOME_COMPATIVEL =
  'export JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || /usr/libexec/java_home -v 21 2>/dev/null)"'

const REGRAS_AMBIENTE: RegraAmbiente[] = [
  {
    // JVM (Gradle/Maven/javac/kotlinc): JDK incompatível. Tem contorno via JAVA_HOME.
    detecta:
      /unsupported class file|invalid source release|unsupportedclassversion|requires java|illegalargumentexception:\s*\d+\.\d+\.\d+|major version \d+|no compatible toolchains|incompatible.*\bjvm\b/i,
    // build/verificação JVM é sempre gradle/maven/javac/kotlinc — nunca um `java` solto (isso é run,
    // não build). Tirar o token largo evita casar a palavra "java" em prosa de comando.
    aplica: /\b(gradlew|gradle|mvnw|mvn|maven|javac|kotlinc)\b/,
    contorno: (comando) => `${JAVA_HOME_COMPATIVEL}; ${comando}`,
    jaContornado: /JAVA_HOME=.*java_home/i,
    mensagem:
      "Java incompatível com o build desta máquina. Instala/usa uma JDK 21 ou 17 (ex.: `brew install --cask corretto`) e roda de novo. Teu código não é o problema.",
  },
  {
    // Node: engine incompatível. Trocar versão em bash não-interativo é frágil → reporta.
    detecta: /unsupported engine|ebadengine|engine "node" is incompatible|the engine "node"|requires node/i,
    aplica: /\b(npm|pnpm|yarn|bun|node|tsc)\b/,
    mensagem:
      "Versão do Node incompatível com o projeto. Usa a versão exigida (`nvm use` ou `fnm use`, veja o campo engines do package.json) e roda de novo.",
  },
  {
    // Python: versão incompatível com o que o projeto exige.
    detecta: /requires python|requires-python|incompatible python|no matching distribution found for python/i,
    aplica: /\b(python\d?|pip\d?|pytest|poetry|uv|ruff)\b/,
    mensagem:
      "Versão do Python incompatível. Usa a versão exigida (`pyenv local <v>` ou um venv com o Python certo) e roda de novo.",
  },
  {
    // Go: toolchain exigido pelo go.mod.
    detecta: /go\.mod requires go|requires go >=|but go\.mod requires|module requires go/i,
    aplica: /\bgo\b/,
    mensagem: "Versão do Go incompatível com o go.mod. Instala a versão exigida e roda de novo.",
  },
  {
    // Rust: toolchain/edition não instalada.
    detecta: /this version of cargo|toolchain '[^']+' is not installed|edition \d{4}.*requires|rustup.*not installed/i,
    aplica: /\b(cargo|rustc|rustup)\b/,
    mensagem:
      "Toolchain do Rust incompatível ou ausente. Roda `rustup update` (ou instala a toolchain exigida) e tenta de novo.",
  },
  {
    // Ferramenta exigida pelo build não está instalada (qualquer linguagem). Sinal de shell inequívoco.
    detecta: /command not found|executable file not found|is not recognized as an internal or external command/i,
    aplica: /.*/,
    mensagem:
      "Uma ferramenta exigida pelo build não está instalada nesta máquina (veja o nome no erro). Instala ela e roda de novo.",
  },
]

/**
 * 4.2 — Contorno de ambiente, agnóstico de linguagem. Casa o erro+comando contra REGRAS_AMBIENTE.
 * Achou regra? Devolve `reexecutar` (o MESMO comando contornado, se a regra tem auto-fix e ainda não
 * foi aplicado) e a `mensagem` honesta. Sem regra => null (não é ambiente; é erro de código, trata
 * pelo outro caminho). Função pura: quem chama tenta `reexecutar` UMA vez e, se falhar, mostra `mensagem`.
 */
export function contornoAmbiente(comando: string, erro: string): AcaoAmbiente | null {
  for (const regra of REGRAS_AMBIENTE) {
    if (!regra.aplica.test(comando)) continue
    if (!regra.detecta.test(erro)) continue
    const jaContornado = regra.jaContornado?.test(comando) ?? false
    const reexecutar = regra.contorno && !jaContornado ? regra.contorno(comando) : null
    return { reexecutar, mensagem: regra.mensagem }
  }
  return null
}

// --- 4.3-COERÊNCIA: trajetória longa -----------------------------------------

export const LIMITE_TRAJETORIA = 16

/**
 * A Fase 2 passou do teto de passos SEM fechar (sem build verde)? Vira ALARME: para, resume o
 * que fez e o que falta, devolve ao usuário — não roda até o teto cego. Função pura testável.
 * Se já está verde, nunca é "longa demais" (terminou bem).
 */
export function trajetoriaLonga(passos: number, verde: boolean): boolean {
  if (verde) return false
  return passos > LIMITE_TRAJETORIA
}

/** Instrução de parada por trajetória longa: resume e devolve, sem rodar até o teto. */
export const INSTRUCAO_TRAJETORIA_LONGA =
  "Você já deu muitos passos sem fechar com build verde. PARE de empilhar mudança. " +
  "Resuma ao usuário o que JÁ fez, o que ainda falta e onde travou (com arquivo:linha). Não rode até o teto cego."
