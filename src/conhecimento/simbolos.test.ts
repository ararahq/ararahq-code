import { test, expect, describe } from "bun:test"
import { extrairSimbolos, indiceReverso, type ArquivoSimbolos } from "./simbolos"

function arq(nome: string, ...simbolos: string[]): ArquivoSimbolos {
  return {
    arquivo: nome,
    linguagem: "Kotlin",
    imports: [],
    simbolos: simbolos.map((s) => ({
      nome: s,
      tipo: "metodo" as const,
      arquivo: nome,
      linhaInicio: 1,
      linhaFim: 2,
      assinatura: "",
      herda: [],
      chama: [],
      usaTipo: [],
    })),
  }
}

describe("indiceReverso — robusto a codebase alheio", () => {
  test("símbolo chamado 'constructor'/'toString'/'hasOwnProperty' não quebra (era crash em codebase real)", () => {
    const rev = indiceReverso([arq("A.kt", "constructor", "toString", "hasOwnProperty", "doWork")])
    expect(rev["constructor"]).toEqual(["A.kt"])
    expect(rev["toString"]).toEqual(["A.kt"])
    expect(rev["hasOwnProperty"]).toEqual(["A.kt"])
    expect(rev["doWork"]).toEqual(["A.kt"])
  })

  test("agrega arquivos por nome de símbolo", () => {
    const rev = indiceReverso([arq("A.kt", "save"), arq("B.kt", "save")])
    expect(rev["save"].sort()).toEqual(["A.kt", "B.kt"])
  })
})

describe("extrairSimbolos — C", () => {
  const c = [
    `#include <stdio.h>`,
    `#include "ledger.h"`,
    `#define MAX_CONTAS 128`,
    ``,
    `typedef struct conta {`,
    `  int id;`,
    `} conta_t;`,
    ``,
    `int saldo_de(const conta_t *c);`,
    ``,
    `static int saldo_de(const conta_t *c) {`,
    `  return c->id;`,
    `}`,
  ].join("\n")

  test("captura função definida, struct e #define; ignora protótipo", () => {
    const r = extrairSimbolos("ledger.c", c)
    expect(r.linguagem).toBe("C")
    const nomes = r.simbolos.map((s) => `${s.tipo}:${s.nome}`)
    expect(nomes).toContain("funcao:saldo_de")
    expect(nomes).toContain("struct:conta")
    expect(nomes).toContain("constante:MAX_CONTAS")

    expect(r.simbolos.filter((s) => s.nome === "saldo_de")).toHaveLength(1)
  })

  test("#include vira import", () => {
    const r = extrairSimbolos("ledger.c", c)
    expect(r.imports.map((i) => i.alvo)).toEqual(["stdio.h", "ledger.h"])
  })
})

describe("extrairSimbolos — C++", () => {
  const cpp = [
    `#include <vector>`,
    `using Saldo = long;`,
    ``,
    `class Ledger : public Base, private detail::Mixin {`,
    ` public:`,
    `  void creditar(Saldo v);`,
    `};`,
    ``,
    `void Ledger::creditar(Saldo v) {`,
    `  total_ += v;`,
    `}`,
  ].join("\n")

  test("classe com herança (especificador de acesso removido), método qualificado e using-alias", () => {
    const r = extrairSimbolos("ledger.cpp", cpp)
    expect(r.linguagem).toBe("C++")
    const classe = r.simbolos.find((s) => s.nome === "Ledger" && s.tipo === "classe")
    expect(classe?.herda).toContain("Base")
    expect(classe?.herda).toContain("Mixin")
    expect(r.simbolos.some((s) => s.tipo === "funcao" && s.nome === "creditar")).toBe(true)
    expect(r.simbolos.some((s) => s.tipo === "tipo" && s.nome === "Saldo")).toBe(true)
  })
})

describe("extrairSimbolos — C#", () => {
  const cs = [
    `using System.Text;`,
    `using var arquivo = File.Open("x");`,
    ``,
    `public interface IRepositorio { }`,
    ``,
    `public sealed class LedgerService : ServiceBase, IRepositorio`,
    `{`,
    `    private const int MaxContas = 128;`,
    ``,
    `    public async Task<int> CreditarAsync(int valor)`,
    `    {`,
    `        return valor;`,
    `    }`,
    `}`,
  ].join("\n")

  test("classe com herança, método com corpo, interface e const", () => {
    const r = extrairSimbolos("LedgerService.cs", cs)
    expect(r.linguagem).toBe("C#")
    const classe = r.simbolos.find((s) => s.nome === "LedgerService")
    expect(classe?.herda).toEqual(["ServiceBase", "IRepositorio"])
    expect(r.simbolos.some((s) => s.tipo === "metodo" && s.nome === "CreditarAsync")).toBe(true)
    expect(r.simbolos.some((s) => s.tipo === "interface" && s.nome === "IRepositorio")).toBe(true)
    expect(r.simbolos.some((s) => s.tipo === "constante" && s.nome === "MaxContas")).toBe(true)
  })

  test("`using X;` importa; `using var` não", () => {
    const r = extrairSimbolos("LedgerService.cs", cs)
    expect(r.imports.map((i) => i.alvo)).toEqual(["System.Text"])
  })
})

describe("extrairSimbolos — Swift", () => {
  const swift = [
    `import SwiftUI`,
    ``,
    `protocol Repositorio { }`,
    ``,
    `final class LedgerService: ServiceBase, Repositorio {`,
    `    @discardableResult`,
    `    public func creditar(_ valor: Int) -> Int {`,
    `        return valor`,
    `    }`,
    `}`,
    ``,
    `struct Conta: Codable {`,
    `    let id: Int`,
    `}`,
  ].join("\n")

  test("classe com herança, protocol, struct e func", () => {
    const r = extrairSimbolos("Ledger.swift", swift)
    expect(r.linguagem).toBe("Swift")
    const classe = r.simbolos.find((s) => s.nome === "LedgerService")
    expect(classe?.herda).toEqual(["ServiceBase", "Repositorio"])
    expect(r.simbolos.some((s) => s.tipo === "interface" && s.nome === "Repositorio")).toBe(true)
    expect(r.simbolos.some((s) => s.tipo === "funcao" && s.nome === "creditar")).toBe(true)
    const conta = r.simbolos.find((s) => s.nome === "Conta" && s.tipo === "struct")
    expect(conta?.herda).toEqual(["Codable"])
    expect(r.imports.map((i) => i.alvo)).toEqual(["SwiftUI"])
  })
})
