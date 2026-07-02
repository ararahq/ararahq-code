import { test, expect, describe, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Backup } from "./backup"

let tmp: string | null = null
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = null
})

describe("3.4 — Backup.reverterAte (revert ao checkpoint)", () => {
  test("restaura arquivo modificado e remove arquivo criado, até a marca", async () => {
    tmp = await mkdtemp(join(tmpdir(), "arara-bkp-"))
    const a = join(tmp, "a.txt")
    const b = join(tmp, "b.txt")
    await Bun.write(a, "v0")

    const marca = Backup.tamanho()

    Backup.registrar(a, "v0")
    await Bun.write(a, "v1")
    Backup.registrar(b, null)
    await Bun.write(b, "novo")

    expect(Backup.tamanho()).toBe(marca + 2)

    await Backup.reverterAte(marca)

    expect(await Bun.file(a).text()).toBe("v0")
    expect(await Bun.file(b).exists()).toBe(false)
    expect(Backup.tamanho()).toBe(marca)
  })
})
