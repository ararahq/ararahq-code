import { describe, expect, test } from "bun:test"
import { alvosDeMakefile } from "./stack"

describe("alvosDeMakefile", () => {
  test("captura alvos declarados e acha test/check", () => {
    const mk = ["CC := gcc", "all: build", "build:", "\t$(CC) main.c", "test: build", "\t./run_tests", ".PHONY: all test"].join("\n")
    const alvos = alvosDeMakefile(mk)
    expect(alvos.has("all")).toBe(true)
    expect(alvos.has("build")).toBe(true)
    expect(alvos.has("test")).toBe(true)
  })

  test("ignora atribuições := e pattern rules %.o", () => {
    const alvos = alvosDeMakefile(["FLAGS := -O2", "%.o: %.c", "\t$(CC) -c $<", "check:", "\t./check"].join("\n"))
    expect(alvos.has("FLAGS")).toBe(false)
    expect(alvos.has("check")).toBe(true)
    expect(alvos.size).toBe(1)
  })

  test(".PHONY e linha de receita (tab) não viram alvo", () => {
    const alvos = alvosDeMakefile([".PHONY: all", "\ttest: isso é receita, não alvo"].join("\n"))
    expect(alvos.size).toBe(0)
  })
})
