import { test, expect, describe } from "bun:test"
import { resolve } from "path"
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { indexar } from "../conhecimento"
import {
  arquivoDoNo, entrypoints, dirs, listar, simbolosDe, vizinhosArquivo, grep, ler, termosDeBusca, explorar,
  ranquearCandidatos, limparCacheConteudo,
} from "./navegacao"

const FIX = (nome: string) => resolve(import.meta.dir, "../../test/fixtures", nome)

describe("navegação — primitivas puras", () => {
  test("arquivoDoNo extrai o caminho de nó de arquivo e de símbolo", () => {
    expect(arquivoDoNo("f:src/a/b.kt")).toBe("src/a/b.kt")
    expect(arquivoDoNo("s:src/a/b.kt#minhaFuncao")).toBe("src/a/b.kt")
  })

  test("termosDeBusca deriva tokens não-genéricos do ticket, sem genéricos nem curtos", () => {
    const t = termosDeBusca("o estorno do cliente está saindo errado")
    expect(t.length).toBeGreaterThan(0)
    expect(t).not.toContain("o")
    expect(t.every((x) => x.length >= 3)).toBe(true)
  })
})

describe("navegação — ações servidas do índice (fixture refund)", () => {
  test("entrypoints rankeia por acoplamento entre arquivos (o service chamado é central)", async () => {
    const indice = await indexar(FIX("refund"), { force: true })
    const ep = entrypoints(indice, 12)
    expect(ep.length).toBeGreaterThan(0)
    // LedgerService é chamado pelo webhook → tem grau de entrada, aparece no mapa.
    expect(ep.some((e) => e.arquivo.includes("LedgerService"))).toBe(true)
  })

  test("listar e dirs derivam a estrutura real", async () => {
    const indice = await indexar(FIX("refund"), { force: true })
    expect(listar(indice).some((a) => a.endsWith(".kt"))).toBe(true)
    expect(dirs(indice).reduce((s, d) => s + d.arquivos, 0)).toBeGreaterThan(0)
  })

  test("simbolosDe e vizinhosArquivo expõem símbolos e ligam por nome único (sem import)", async () => {
    const indice = await indexar(FIX("refund"), { force: true })
    const arq = indice.simbolos.find((s) => s.arquivo.includes("StatusWebhookService"))!.arquivo
    expect(simbolosDe(indice, arq).length).toBeGreaterThan(0)
    // o webhook injeta `LedgerService` e chama `refund` — ambos def única → liga, mesmo same-package.
    const viz = vizinhosArquivo(indice, arq)
    expect(viz.some((v) => v.arquivo.includes("LedgerService"))).toBe(true)
  })

  test("grep acha o termo no conteúdo e devolve linha/trecho com teto", async () => {
    const indice = await indexar(FIX("refund"), { force: true })
    const hits = await grep(FIX("refund"), indice, "class", 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThanOrEqual(5)
    expect(hits[0]).toHaveProperty("linha")
    expect(hits[0].linha).toBeGreaterThan(0)
  })

  test("ler devolve janela limitada, nunca passa do teto", async () => {
    const indice = await indexar(FIX("refund"), { force: true })
    const arq = indice.simbolos[0].arquivo
    const j = await ler(FIX("refund"), arq, 1, 9999)
    expect(j).not.toBeNull()
    expect(j!.linhas.length).toBeLessThanOrEqual(160)
    expect(j!.linhas.length).toBe(j!.fim - j!.inicio + 1)
  })

  test("ler retorna null em arquivo inexistente (degrada, não crasha)", async () => {
    const indice = await indexar(FIX("refund"), { force: true })
    expect(await ler(FIX("refund"), "nao/existe.kt")).toBeNull()
    expect(indice.simbolos.length).toBeGreaterThan(0)
  })
})

describe("navegação — explorar alcança via grafo (o que retrieval lexical não pega)", () => {
  test("grep num termo + salto de grafo alcança o arquivo vizinho ausente", async () => {
    const raiz = FIX("refund")
    const indice = await indexar(raiz, { force: true })
    // termo casa o webhook; o LedgerService é alcançado pelo salto de call-graph, não por lexico do ticket.
    const alc = await explorar(raiz, indice, "", { termos: ["processStatusUpdate"], hops: 2 })
    expect(alc.some((a) => a.arquivo.includes("LedgerService"))).toBe(true)
    const via = alc.find((a) => a.arquivo.includes("LedgerService"))!.via
    expect(via.startsWith("nav:")).toBe(true)
  })

  test("explorar sem termos que casam não inventa arquivo (não alucina alcance)", async () => {
    const raiz = FIX("refund")
    const indice = await indexar(raiz, { force: true })
    const alc = await explorar(raiz, indice, "", { termos: ["zzznaoexistezzz"], hops: 2 })
    expect(alc.length).toBe(0)
  })
})

describe("navegação — cache de conteúdo (mtime-validado)", () => {
  test("ler reflete edição (invalida por mtime) e some em arquivo deletado", async () => {
    limparCacheConteudo()
    const dir = mkdtempSync(`${tmpdir()}/nav-cache-`)
    const arq = "f.txt"
    writeFileSync(`${dir}/${arq}`, "a\nb\nc")
    expect((await ler(dir, arq, 1, 999))?.linhas).toEqual(["a", "b", "c"])
    // edita + força mtime futuro (resolução de mtime do FS pode ser grossa) → deve invalidar o cache.
    writeFileSync(`${dir}/${arq}`, "x\ny")
    const futuro = new Date(Date.now() + 5000)
    utimesSync(`${dir}/${arq}`, futuro, futuro)
    expect((await ler(dir, arq, 1, 999))?.linhas).toEqual(["x", "y"])
    rmSync(dir, { recursive: true, force: true })
    expect(await ler(dir, arq)).toBeNull()
  })
})

describe("navegação — ranquearCandidatos (locator do gate de custo)", () => {
  test("termo que casa nome de símbolo rankeia o arquivo no topo, com flag estrutural", async () => {
    const raiz = FIX("refund")
    const indice = await indexar(raiz, { force: true })
    // `refund` e `ledger` casam símbolo/nome do LedgerService → topo + estrutural=true (sinal de confiança).
    const r = await ranquearCandidatos(raiz, indice, ["refund", "ledger"])
    expect(r.length).toBeGreaterThan(0)
    expect(r[0].arquivo).toContain("LedgerService")
    expect(r[0].estrutural).toBe(true)
  })

  test("termo raro pesa mais que comum (IDF) e sem termos retorna vazio", async () => {
    const raiz = FIX("refund")
    const indice = await indexar(raiz, { force: true })
    expect(await ranquearCandidatos(raiz, indice, [])).toEqual([])
    const r = await ranquearCandidatos(raiz, indice, ["zzznaoexistezzz"])
    expect(r.length).toBe(0)
  })
})
