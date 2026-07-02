import { test, expect, describe, beforeEach } from "bun:test"
import {
  resetCamada4,
  acaoRepetida,
  registrarEdicao,
  contradizEdicaoAnterior,
  escopoDoDiagnostico,
  dentroDoEscopo,
  contornoAmbiente,
} from "./camada4"

beforeEach(() => resetCamada4())

describe("4.3 — acaoRepetida", () => {
  test("primeira chamada é nova, segunda idêntica é repetida", () => {
    expect(acaoRepetida("rodar_comando", "ls -la")).toBe(false)
    expect(acaoRepetida("rodar_comando", "ls -la")).toBe(true)
  })
  test("tool ou argumento diferente não conta como repetida", () => {
    expect(acaoRepetida("rodar_comando", "ls")).toBe(false)
    expect(acaoRepetida("rodar_comando", "pwd")).toBe(false)
    expect(acaoRepetida("listar", "ls")).toBe(false)
  })
  test("resetCamada4 limpa o tracker", () => {
    acaoRepetida("rodar_comando", "ls")
    resetCamada4()
    expect(acaoRepetida("rodar_comando", "ls")).toBe(false)
  })
})

describe("4.3 — contradizEdicaoAnterior", () => {
  test("desfazer a própria edição (flip-flop) é barrado", () => {
    registrarEdicao("src/a.ts", "antigo", "novo")
    expect(contradizEdicaoAnterior("src/a.ts", "novo", "antigo")).toBe(true)
  })
  test("editar outro arquivo não conflita (salvaguarda de escopo)", () => {
    registrarEdicao("src/a.ts", "antigo", "novo")
    expect(contradizEdicaoAnterior("src/b.ts", "novo", "antigo")).toBe(false)
  })
  test("sem histórico não há contradição", () => {
    expect(contradizEdicaoAnterior("src/a.ts", "x", "y")).toBe(false)
  })
})

describe("3.7 — escopoDoDiagnostico agnóstico (regressão)", () => {
  test("extrai arquivos de extensões fora da lista antiga e casa no escopo", () => {
    const escopo = escopoDoDiagnostico("a causa está em deploy.sh:12 e em helper.rb")
    expect(escopo.livre).toBe(false)
    expect(dentroDoEscopo(escopo, "scripts/deploy.sh")).toBe(true)
    expect(dentroDoEscopo(escopo, "lib/helper.rb")).toBe(true)
    expect(dentroDoEscopo(escopo, "outro.ts")).toBe(false)
  })
})

describe("contornoAmbiente — JDK novo demais pro plugin Kotlin", () => {
  test("gradle que imprime só a versão após 'What went wrong' é AMBIENTE com contorno de JAVA_HOME", () => {
    const saida = "FAILURE: Build failed with an exception.\n\n* What went wrong:\n25.0.1\n\n* Try:\n> Run with --stacktrace"
    const acao = contornoAmbiente("./gradlew build", saida)
    expect(acao).not.toBeNull()
    expect(acao?.reexecutar).toContain("JAVA_HOME")
  })

  test("mensagem parecida em comando não-JVM não vira ambiente", () => {
    expect(contornoAmbiente("bun test", "* What went wrong:\n25.0.1")).toBeNull()
  })
})
