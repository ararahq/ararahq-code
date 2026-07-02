import { describe, expect, test } from "bun:test"
import { slugDeBranch, mensagemCommit, tituloPR, corpoPR } from "./git"
import type { RelatorioExecucao } from "../autonomo/tipos"

describe("slugDeBranch", () => {
  test("kebab sem acento, prefixo jade/, hash curto", () => {
    const s = slugDeBranch("Corrigir o timeout do webhook de pagamentos")
    expect(s).toMatch(/^jade\/corrigir-o-timeout-do-webhook-de-pagamen[a-z-]*-[0-9a-f]{6}$/)
  })

  test("é determinístico: retry da mesma instrução cai no mesmo branch", () => {
    expect(slugDeBranch("conserta o bug X")).toBe(slugDeBranch("conserta o bug X"))
  })

  test("instruções diferentes dão branches diferentes", () => {
    expect(slugDeBranch("conserta o bug X")).not.toBe(slugDeBranch("conserta o bug Y"))
  })

  test("instrução só de símbolos não gera slug vazio", () => {
    expect(slugDeBranch("!!! ###")).toMatch(/^jade\/tarefa-[0-9a-f]{6}$/)
  })
})

describe("mensagemCommit / tituloPR", () => {
  test("uma linha, truncada", () => {
    const longa = "a".repeat(200)
    expect(mensagemCommit(longa).length).toBeLessThanOrEqual(72 + "jade: ".length)
    expect(tituloPR(longa).length).toBeLessThanOrEqual(90 + "[Jade] ".length)
  })

  test("colapsa quebras de linha", () => {
    expect(mensagemCommit("corrige\n\no  bug")).toBe("jade: corrige o bug")
  })
})

describe("corpoPR", () => {
  const rel = (estado: RelatorioExecucao["estado"]): RelatorioExecucao => ({
    estado,
    resposta: "causa raiz em src/a.ts:10",
    arquivosEditados: ["src/a.ts"],
    diff: "",
    ms: 1000,
  })

  test("verde declara o gate fechado", () => {
    expect(corpoPR("tarefa", rel("verde"))).toContain("**verde**")
  })

  test("vermelho avisa que NÃO está pronto — sem maquiagem", () => {
    const corpo = corpoPR("tarefa", rel("vermelho"))
    expect(corpo).toContain("NÃO fechou verde")
    expect(corpo).toContain("progresso parcial")
  })

  test("sem-gate pede revisão com mais cuidado", () => {
    expect(corpoPR("tarefa", rel("sem-gate"))).toContain("revise com mais cuidado")
  })

  test("lista os arquivos tocados", () => {
    expect(corpoPR("tarefa", rel("verde"))).toContain("`src/a.ts`")
  })
})
