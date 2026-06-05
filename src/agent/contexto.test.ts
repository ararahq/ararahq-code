import { test, expect, describe, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { montarMapaAmplo, montarPacote, parearPorGrafo } from "./contexto"

describe("pareamento genérico (Sinal 1) — sem domínio/JPA", () => {
  test("pareia métodos irmãos cujos callees são variantes da mesma operação", () => {
    const chamadas = [
      { metodo: "assignShared", arquivo: "S.kt", linha: 10, chamada: "findFirstByIsActiveTrue" },
      { metodo: "pickPool", arquivo: "S.kt", linha: 20, chamada: "findFirstByOrganizationIdIsNullAndIsActiveTrue" },
      { metodo: "naoRelacionado", arquivo: "S.kt", linha: 30, chamada: "enviarEmailDeBoasVindas" },
    ]
    const pares = parearPorGrafo(chamadas, ["shared"])
    expect(pares.length).toBeGreaterThan(0)
    expect(`${pares[0].a.chamada}${pares[0].b.chamada}`).toMatch(/findFirst/i)
  })

  test("callees dissimilares não viram par (não conhece domínio, só estrutura)", () => {
    const chamadas = [
      { metodo: "a", arquivo: "S.kt", linha: 10, chamada: "salvarPedido" },
      { metodo: "b", arquivo: "S.kt", linha: 20, chamada: "calcularImpostoRetido" },
    ]
    expect(parearPorGrafo(chamadas, [])).toEqual([])
  })

  test("genérico em outro domínio (banco): buscaConta vs buscaContaAtiva pareiam", () => {
    const chamadas = [
      { metodo: "transferir", arquivo: "Conta.java", linha: 5, chamada: "buscarContaPorTitular" },
      { metodo: "transferirAtiva", arquivo: "Conta.java", linha: 15, chamada: "buscarContaPorTitularAtiva" },
    ]
    expect(parearPorGrafo(chamadas, []).length).toBeGreaterThan(0)
  })
})

const homeOriginal = process.env.HOME
let raiz: string | null = null

afterEach(async () => {
  process.env.HOME = homeOriginal
  if (raiz) await rm(raiz, { recursive: true, force: true })
  raiz = null
})

describe("copiloto — montarMapaAmplo (Camada 2 modo amplo)", () => {
  test("monta panorama dos arquivos relevantes ao pedido, com assinaturas, sem corpos", async () => {
    raiz = await mkdtemp(join(tmpdir(), "arara-amplo-"))
    process.env.HOME = raiz // índice persiste em $HOME/.arara (fora da árvore varrida)
    await writeFile(join(raiz, "auth.ts"), "export function authLogin(user: string) {\n  return user\n}\n")
    await writeFile(join(raiz, "matematica.ts"), "export function somar(a: number, b: number) {\n  return a + b\n}\n")

    const r = await montarMapaAmplo(raiz, "me explica como funciona o auth", null)

    expect(r.arquivos).toContain("auth.ts")
    expect(r.texto).toContain("auth.ts")
    expect(r.texto).toContain("authLogin")
    expect(r.texto).toContain("MAPA DO PROJETO")
  })

  test("sem entidade casando, cai nos arquivos centrais (panorama geral)", async () => {
    raiz = await mkdtemp(join(tmpdir(), "arara-amplo-"))
    process.env.HOME = raiz
    await writeFile(join(raiz, "core.ts"), "export function a() {}\nexport function b() {}\nexport function c() {}\n")

    const r = await montarMapaAmplo(raiz, "me dá uma visão geral do projeto", null)
    expect(r.arquivos).toContain("core.ts")
  })
})

describe("retrieval por CONTEÚDO (indexar de verdade) + ponte de domínio", () => {
  test("acha o arquivo por termo do conteúdo (constante de módulo), não só por símbolo", async () => {
    raiz = await mkdtemp(join(tmpdir(), "arara-ctx-"))
    process.env.HOME = raiz
    // base_url é constante de módulo — NÃO é classe/função, então o mapa de símbolos não a vê.
    await writeFile(join(raiz, "config.py"), 'base_url = "https://api.exemplo.io"\ntimeout = 30\n')
    await writeFile(join(raiz, "matematica.py"), "def somar(a, b):\n    return a + b\n")

    const pkg = await montarPacote(raiz, "a lib tá dando erro de conexão, não conecta")
    expect(pkg.arquivosFoco.join(" ")).toContain("config.py")
    expect(pkg.forte).toBe(true)
  })
})
