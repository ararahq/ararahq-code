// Runner do conjunto de avaliação. Dois níveis:
//   Tier 1 (grátis, sem modelo): roteamento (rotear) + seleção de contexto (montarPacote).
//   Tier 2 (--full, com OPENROUTER_API_KEY): diagnóstico real — cravou? quanto custou? quanto demorou?
// Compara com eval/placar-base.json; --salvar grava o resultado atual como novo base.

import { resolve } from "node:path"
import { generateText } from "ai"
import { CASOS, type Caso } from "./casos"
import { rotear, MODELOS, custoUSD, CADEIA_DIAGNOSTICO } from "../src/agent/router"
import { montarPacote, type PacoteContexto } from "../src/agent/contexto"
import { diagnosticarComFallback } from "../src/agent/diagnostico"
import { provedor, SemApiKey } from "../src/llm/openrouter"

type Modelo = Parameters<typeof generateText>[0]["model"]

const RAIZ = process.env.ARARA_RAIZ ?? resolve(import.meta.dir, "../..")
const FULL = process.argv.includes("--full")
const SALVAR = process.argv.includes("--salvar")
const PLACAR = resolve(import.meta.dir, "placar-base.json")

type Placar = {
  roteamento: { ok: number; total: number }
  contexto: { ok: number; total: number }
  pares: { ok: number; total: number }
  cravou: { ok: number; total: number }
  custoUSD: number
  ms: number
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length))
const marca = (b: boolean | null) => (b === null ? "-" : b ? "OK" : "XX")

function marchaOk(caso: Caso, d: ReturnType<typeof rotear>): boolean {
  if (caso.marchaEsperada === "loop-longo") return d.modelo === MODELOS.loopLongo
  return d.modo === caso.marchaEsperada
}

function arquivosOk(caso: Caso, pkg: PacoteContexto): boolean {
  const todos = [...pkg.arquivosFoco, ...pkg.trechos.map((t) => t.arquivo)]
  return (caso.arquivosEsperados ?? []).every((exp) => todos.some((a) => a.includes(exp)))
}

function paresOk(caso: Caso, pkg: PacoteContexto): boolean {
  const blob = pkg.pares.map((p) => `${p.a.metodo} ${p.a.chamada} ${p.b.metodo} ${p.b.chamada}`).join(" ")
  return (caso.paresEsperados ?? []).every((exp) => blob.includes(exp))
}

type LinhaT1 = { id: string; rota: boolean | null; ctx: boolean | null; par: boolean | null; forte: boolean | null }

async function tier1(): Promise<{ linhas: LinhaT1[]; ctxPorCaso: Map<string, boolean> }> {
  const linhas: LinhaT1[] = []
  const ctxPorCaso = new Map<string, boolean>()
  for (const caso of CASOS) {
    const rota = caso.marchaEsperada ? marchaOk(caso, rotear(caso.prompt)) : null
    let ctx: boolean | null = null
    let par: boolean | null = null
    let forte: boolean | null = null
    if (caso.arquivosEsperados || caso.paresEsperados) {
      const casoRaiz = caso.raiz ? resolve(import.meta.dir, caso.raiz) : RAIZ
      const pkg = await montarPacote(casoRaiz, caso.prompt)
      forte = pkg.forte
      if (caso.arquivosEsperados) {
        ctx = arquivosOk(caso, pkg)
        ctxPorCaso.set(caso.id, ctx)
      }
      if (caso.paresEsperados) par = paresOk(caso, pkg)
    }
    linhas.push({ id: caso.id, rota, ctx, par, forte })
  }
  return { linhas, ctxPorCaso }
}

type LinhaT2 = { id: string; cravou: boolean; ctx: boolean | null; custoUSD: number; ms: number }

async function tier2(ctxPorCaso: Map<string, boolean>): Promise<LinhaT2[] | null> {
  let op: ReturnType<typeof provedor>
  try {
    op = provedor()
  } catch (e) {
    if (e instanceof SemApiKey) return null
    throw e
  }
  const criar = (slug: string) => op(slug) as Modelo
  const linhas: LinhaT2[] = []
  for (const caso of CASOS) {
    if (!caso.cravouSe) continue
    // reunirMaterial usa process.cwd() como raiz do índice — aponta pro fixture do caso (estado bugado).
    process.chdir(caso.raiz ? resolve(import.meta.dir, caso.raiz) : RAIZ)
    const t0 = Date.now()
    const diag = await diagnosticarComFallback(caso.prompt, [...CADEIA_DIAGNOSTICO], criar, custoUSD, () => {}, () => {})
    const cravou = caso.cravouSe.every((re) => re.test(diag.texto))
    linhas.push({ id: caso.id, cravou, ctx: ctxPorCaso.get(caso.id) ?? null, custoUSD: diag.custoUSD, ms: Date.now() - t0 })
  }
  process.chdir(RAIZ)
  return linhas
}

function delta(atual: number, base: number | undefined): string {
  if (base === undefined) return ""
  const d = atual - base
  if (d === 0) return " (=)"
  return d > 0 ? ` (+${d})` : ` (${d})`
}

async function main() {
  process.chdir(RAIZ) // reunirMaterial (Tier 2) usa process.cwd() como raiz do índice
  let base: Placar | null = null
  try {
    base = (await Bun.file(PLACAR).json()) as Placar
  } catch {
    // sem placar-base ainda — primeira rodada vira a referência
  }

  console.log(`\nConjunto de avaliação — ${CASOS.length} casos · raiz ${RAIZ}\n`)
  console.log(`  ${pad("caso", 34)}${pad("rota", 6)}${pad("ctx", 6)}${pad("par", 6)}forte`)
  const { linhas, ctxPorCaso } = await tier1()
  for (const l of linhas) {
    console.log(`  ${pad(l.id, 34)}${pad(marca(l.rota), 6)}${pad(marca(l.ctx), 6)}${pad(marca(l.par), 6)}${marca(l.forte)}`)
  }

  const rota = { ok: linhas.filter((l) => l.rota === true).length, total: linhas.filter((l) => l.rota !== null).length }
  const ctx = { ok: linhas.filter((l) => l.ctx === true).length, total: linhas.filter((l) => l.ctx !== null).length }
  const par = { ok: linhas.filter((l) => l.par === true).length, total: linhas.filter((l) => l.par !== null).length }

  console.log("")
  console.log(`  Roteamento: ${rota.ok}/${rota.total}${delta(rota.ok, base?.roteamento.ok)}`)
  console.log(`  Contexto:   ${ctx.ok}/${ctx.total}${delta(ctx.ok, base?.contexto.ok)}   (o arquivo certo estava no pacote?)`)
  console.log(`  Pares:      ${par.ok}/${par.total}${delta(par.ok, base?.pares.ok)}`)

  let cravou = { ok: 0, total: 0 }
  let custoTotal = 0
  let msTotal = 0
  if (FULL) {
    const t2 = await tier2(ctxPorCaso)
    if (!t2) {
      console.log("\n  Tier 2 PULADO: defina OPENROUTER_API_KEY pra medir diagnóstico real.")
    } else {
      console.log(`\n  ${pad("caso (diagnóstico real)", 34)}${pad("cravou", 8)}${pad("ctx", 6)}${pad("custo", 10)}tempo`)
      let ctxFaltou = 0
      let modeloFalhou = 0
      for (const l of t2) {
        console.log(`  ${pad(l.id, 34)}${pad(l.cravou ? "OK" : "XX", 8)}${pad(marca(l.ctx), 6)}${pad(`$${l.custoUSD.toFixed(4)}`, 10)}${(l.ms / 1000).toFixed(1)}s`)
        custoTotal += l.custoUSD
        msTotal += l.ms
        if (!l.cravou) l.ctx === false ? ctxFaltou++ : modeloFalhou++
      }
      cravou = { ok: t2.filter((l) => l.cravou).length, total: t2.length }
      console.log("")
      console.log(`  Cravou: ${cravou.ok}/${cravou.total}${delta(cravou.ok, base?.cravou.ok)}   custo $${custoTotal.toFixed(4)}   tempo ${(msTotal / 1000).toFixed(1)}s`)
      console.log(`  Das falhas: ${ctxFaltou} por CONTEXTO faltando, ${modeloFalhou} por RACIOCÍNIO (contexto estava lá).`)
    }
  } else {
    console.log("\n  (Tier 2 desligado — rode com `--full` pra medir diagnóstico real, custo e tempo.)")
  }

  if (SALVAR) {
    const placar: Placar = { roteamento: rota, contexto: ctx, pares: par, cravou, custoUSD: custoTotal, ms: msTotal }
    await Bun.write(PLACAR, JSON.stringify(placar, null, 2))
    console.log(`\n  placar-base salvo em ${PLACAR}`)
  } else if (base) {
    console.log("\n  (deltas vs placar-base; rode com `--salvar` pra atualizar a referência.)")
  } else {
    console.log("\n  (sem placar-base ainda; rode com `--salvar` pra fixar esta rodada como referência.)")
  }
  console.log("")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
