import type { ProjectInfo } from "../conhecimento/stack"
import { extrairArquivosCitados } from "../engine/refcodigo"
import { detectarContradicao, type Edicao } from "../engine/marques"

function normalizarArquivo(bruto: string): string {
  return bruto.replace(/^\.\//, "").replace(/:\d+.*$/, "").trim()
}

export type Escopo = {
  arquivos: Set<string>

  bases: Set<string>
  livre: boolean
}

export function escopoDoDiagnostico(textoMastigado: string): Escopo {
  const arquivos = extrairArquivosCitados(textoMastigado).map(normalizarArquivo).filter(Boolean)
  return montarEscopo([...new Set(arquivos)])
}

export function escopoDeArquivos(arquivos: string[]): Escopo {
  return montarEscopo(arquivos.map(normalizarArquivo).filter(Boolean))
}

function montarEscopo(lista: string[]): Escopo {
  const arquivos = new Set(lista)
  const bases = new Set([...arquivos].map((a) => a.split("/").pop() ?? a))
  return { arquivos, bases, livre: arquivos.size === 0 }
}

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

export function avisoForaDoEscopo(escopo: Escopo, caminho: string): string {
  const permitidos = [...escopo.arquivos].join(", ")
  return (
    `EDIÇÃO BLOQUEADA: ${caminho} está FORA do que foi diagnosticado/pedido (escopo: ${permitidos}). ` +
    `NÃO corrija por conta própria — um uso parecido pode usar esse comportamento DE PROPÓSITO, e mexer às cegas vira regressão. ` +
    `Em vez de editar: LISTE pro usuário os outros pontos candidatos que você achou (com arquivo:linha) e PERGUNTE se ele quer que você corrija também, ` +
    `avisando que cada um pode ter semântica diferente. Só siga depois da confirmação dele.`
  )
}

type EstadoCamada4 = {
  escopo: Escopo
  editados: Set<string>

  edicoesFeitas: Set<string>

  candidatos: Set<string>

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

export function resetCamada4(): void {
  estado = estadoVazio()
}

export function definirEscopo(escopo: Escopo): void {
  estado.escopo = escopo
}

export function escopoAtual(): Escopo {
  return estado.escopo
}

export function arquivosEditados(): string[] {
  return [...estado.editados].sort()
}

export function registrarEdicao(caminho: string, ancora = "", novo = ""): void {
  const arq = normalizarArquivo(caminho)
  estado.editados.add(arq)
  estado.historico.push({ arquivo: arq, ancora, novo })
}

export function contradizEdicaoAnterior(caminho: string, ancora: string | undefined, novo: string): boolean {
  return detectarContradicao(estado.historico, { arquivo: normalizarArquivo(caminho), ancora: ancora ?? "", novo })
}

export function acaoRepetida(tool: string, argumento: string): boolean {
  const k = `${tool}::${argumento}`
  if (estado.acoes.has(k)) return true
  estado.acoes.add(k)
  return false
}

export function houveEdicao(): boolean {
  return estado.editados.size > 0
}

export function registrarCandidatoForaEscopo(caminho: string): void {
  estado.candidatos.add(normalizarArquivo(caminho))
}

export function candidatosForaEscopo(): string[] {
  return [...estado.candidatos].sort()
}

function chaveEdicao(caminho: string, ancora: string, novo: string): string {
  return JSON.stringify([normalizarArquivo(caminho), ancora, novo])
}

export function edicaoRepetida(caminho: string, ancora: string | undefined, novo: string): boolean {
  const k = chaveEdicao(caminho, ancora ?? "", novo)
  if (estado.edicoesFeitas.has(k)) return true
  estado.edicoesFeitas.add(k)
  return false
}

export function precisaTestGate(houveEdicao: boolean): boolean {
  return houveEdicao
}

export type Gate = { build: string; test: string | null; subprojeto: string }

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

const TEST_CARO = /\b(gradle|gradlew|mvn|maven|integrationTest|e2e|cypress|playwright)\b/i

function testBarato(testCmd: string | null): string | null {
  if (!testCmd) return null
  return TEST_CARO.test(testCmd) ? null : testCmd
}

export function comandosDoGate(gate: Gate): string[] {
  return gate.test ? [gate.build, gate.test] : [gate.build]
}

export const INSTRUCAO_GATE_VERMELHO =
  "O build falhou após a tua edição. NÃO faça edição nova fora do conserto. " +
  "Conserte exatamente o que quebrou OU reverta a mudança que causou — e só finalize quando o build ficar verde. " +
  "Se a falha for de ambiente (versão de Java/ferramenta), aplique o contorno de JAVA_HOME ou pare e diga ao usuário. " +
  "Não narre nem repita este aviso na tua resposta ao usuário — só aja."

export const INSTRUCAO_GATE_VERDE =
  "O build passou — a correção está consistente. Finalize com um resumo curto ao usuário. Não mencione este aviso."

export type AcaoAmbiente = {

  reexecutar: string | null

  mensagem: string
}

type RegraAmbiente = {

  detecta: RegExp

  aplica: RegExp

  contorno?: (comando: string) => string

  jaContornado?: RegExp

  mensagem: string
}

const JAVA_HOME_COMPATIVEL =
  'export JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || /usr/libexec/java_home -v 21 2>/dev/null)"'

const REGRAS_AMBIENTE: RegraAmbiente[] = [
  {

    detecta:
      /unsupported class file|invalid source release|unsupportedclassversion|requires java|illegalargumentexception:\s*\d+\.\d+\.\d+|major version \d+|no compatible toolchains|incompatible.*\bjvm\b|what went wrong:\s*\r?\n\s*\d{1,3}(\.\d+){1,2}\b/i,

    aplica: /\b(gradlew|gradle|mvnw|mvn|maven|javac|kotlinc)\b/,
    contorno: (comando) => `${JAVA_HOME_COMPATIVEL}; ${comando}`,
    jaContornado: /JAVA_HOME=.*java_home/i,
    mensagem:
      "Java incompatível com o build desta máquina. Instala/usa uma JDK 21 ou 17 (ex.: `brew install --cask corretto`) e roda de novo. Teu código não é o problema.",
  },
  {

    detecta: /unsupported engine|ebadengine|engine "node" is incompatible|the engine "node"|requires node/i,
    aplica: /\b(npm|pnpm|yarn|bun|node|tsc)\b/,
    mensagem:
      "Versão do Node incompatível com o projeto. Usa a versão exigida (`nvm use` ou `fnm use`, veja o campo engines do package.json) e roda de novo.",
  },
  {

    detecta: /requires python|requires-python|incompatible python|no matching distribution found for python/i,
    aplica: /\b(python\d?|pip\d?|pytest|poetry|uv|ruff)\b/,
    mensagem:
      "Versão do Python incompatível. Usa a versão exigida (`pyenv local <v>` ou um venv com o Python certo) e roda de novo.",
  },
  {

    detecta: /go\.mod requires go|requires go >=|but go\.mod requires|module requires go/i,
    aplica: /\bgo\b/,
    mensagem: "Versão do Go incompatível com o go.mod. Instala a versão exigida e roda de novo.",
  },
  {

    detecta: /this version of cargo|toolchain '[^']+' is not installed|edition \d{4}.*requires|rustup.*not installed/i,
    aplica: /\b(cargo|rustc|rustup)\b/,
    mensagem:
      "Toolchain do Rust incompatível ou ausente. Roda `rustup update` (ou instala a toolchain exigida) e tenta de novo.",
  },
  {

    detecta: /command not found|executable file not found|is not recognized as an internal or external command/i,
    aplica: /.*/,
    mensagem:
      "Uma ferramenta exigida pelo build não está instalada nesta máquina (veja o nome no erro). Instala ela e roda de novo.",
  },
]

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

export const LIMITE_TRAJETORIA = 16

export function trajetoriaLonga(passos: number, verde: boolean): boolean {
  if (verde) return false
  return passos > LIMITE_TRAJETORIA
}

export const INSTRUCAO_TRAJETORIA_LONGA =
  "Você já deu muitos passos sem fechar com build verde. PARE de empilhar mudança. " +
  "Resuma ao usuário o que JÁ fez, o que ainda falta e onde travou (com arquivo:linha). Não rode até o teto cego."

export const INSTRUCAO_RELATORIO_CORTE =
  "O orçamento de passos desta tarefa acabou e você não concluiu. NÃO use nenhuma ferramenta. " +
  "Escreva AGORA o relatório final pro usuário, direto e sem narração de processo: " +
  "(1) o que você DESCOBRIU (com arquivo:linha), (2) o que chegou a FAZER, (3) o que FALTA e como continuar."
