import { describe, expect, test } from "bun:test"
import {
  extrairDepreciacoes,
  identificadorDe,
  rotuloFamilia,
  montarTarefaFamilia,
  contarUsosRestantes,
  relatorioDepreciacoes,
  comandoWarnings,
} from "./depreciacao"

const RAIZ = "/repo"
const SAIDA_KOTLIN = [
  "> Task :compileKotlin",
  "w: file:///repo/src/main/kotlin/com/arara/api/services/WebhookService.kt:185:31 'fun calculatePrice(template: Template, isTestMode: Boolean = ..., planType: PlanType? = ..., organizationId: UUID? = ...): BigDecimal' is deprecated. Use calculatePricing.",
  "w: file:///repo/src/main/kotlin/com/arara/api/workers/CampaignExpanderWorker.kt:83:40 'fun calculatePrice(template: Template, isTestMode: Boolean = ..., planType: PlanType? = ..., organizationId: UUID? = ...): BigDecimal' is deprecated. Use calculatePricing.",
  "w: file:///repo/src/main/kotlin/com/arara/api/workers/CampaignExpanderWorker.kt:87:28 'fun calculatePrice(template: Template, isTestMode: Boolean = ..., planType: PlanType? = ..., organizationId: UUID? = ...): BigDecimal' is deprecated. Use calculatePricing.",
  "w: file:///repo/src/main/kotlin/com/arara/api/services/TwilioService.kt:1081:19 'fun fields(): (MutableIterator<(MutableMap.MutableEntry<String!, JsonNode!>..Map.Entry<String!, JsonNode!>?)>..Iterator<(MutableMap.MutableEntry<String!, JsonNode!>..Map.Entry<String!, JsonNode!>?)>?)' is deprecated. Deprecated in Java.",
  "w: file:///repo/src/test/kotlin/com/arara/api/services/TwilioServiceTest.kt:537:60 'constructor(p0: String!, p1: Throwable!): JsonMappingException' is deprecated. Deprecated in Java.",
  "BUILD SUCCESSFUL in 17s",
].join("\n")

describe("extrairDepreciacoes", () => {
  test("agrupa por assinatura, normaliza path e ordena por volume", () => {
    const familias = extrairDepreciacoes(SAIDA_KOTLIN, RAIZ)
    expect(familias).toHaveLength(3)
    const calc = familias[0]
    expect(calc.assinatura).toContain("calculatePrice")
    expect(calc.dica).toBe("Use calculatePricing.")
    expect(calc.locais).toHaveLength(3)
    expect(calc.arquivos).toEqual([
      "src/main/kotlin/com/arara/api/services/WebhookService.kt",
      "src/main/kotlin/com/arara/api/workers/CampaignExpanderWorker.kt",
    ])
  })

  test("dedup de linha repetida (build reprinta) não duplica local", () => {
    const familias = extrairDepreciacoes(`${SAIDA_KOTLIN}\n${SAIDA_KOTLIN}`, RAIZ)
    expect(familias[0].locais).toHaveLength(3)
  })

  test("cobre formato javac [deprecation]", () => {
    const familias = extrairDepreciacoes(
      "src/main/java/com/x/Foo.java:42: warning: [deprecation] bar() in Baz has been deprecated",
      RAIZ,
    )
    expect(familias).toHaveLength(1)
    expect(familias[0].locais[0]).toEqual({ arquivo: "src/main/java/com/x/Foo.java", linha: 42 })
  })

  test("saída sem depreciação devolve vazio", () => {
    expect(extrairDepreciacoes("BUILD SUCCESSFUL in 2s\n> Task :compileKotlin UP-TO-DATE", RAIZ)).toEqual([])
  })
})

describe("identificadorDe / rotuloFamilia", () => {
  const familias = extrairDepreciacoes(SAIDA_KOTLIN, RAIZ)

  test("extrai o identificador de fun e de constructor", () => {
    expect(identificadorDe(familias[0])).toBe("calculatePrice")
    const ctor = familias.find((f) => f.assinatura.startsWith("constructor"))
    expect(ctor && identificadorDe(ctor)).toBe("JsonMappingException")
  })

  test("rotulo usa o identificador quando existe", () => {
    expect(rotuloFamilia(familias[0])).toBe("calculatePrice")
  })
})

describe("montarTarefaFamilia", () => {
  test("lista os pontos exatos, o substituto e as travas de escopo", () => {
    const [calc] = extrairDepreciacoes(SAIDA_KOTLIN, RAIZ)
    const tarefa = montarTarefaFamilia(calc)
    expect(tarefa).toContain("Use calculatePricing.")
    expect(tarefa).toContain("src/main/kotlin/com/arara/api/services/WebhookService.kt:185")
    expect(tarefa).toContain("NÃO refatore")
    expect(tarefa).toContain("rode o build")
  })
})

describe("contarUsosRestantes", () => {
  const [calc] = extrairDepreciacoes(SAIDA_KOTLIN, RAIZ)

  test("conta chamada restante sem casar o substituto (calculatePricing não conta)", async () => {
    const conteudo: Record<string, string> = {
      "src/main/kotlin/com/arara/api/services/WebhookService.kt": "val a = pricing.calculatePricing(t)\nval b = pricing.calculatePrice(t)",
      "src/main/kotlin/com/arara/api/workers/CampaignExpanderWorker.kt": "val c = pricing.calculatePricing(t)",
    }
    expect(await contarUsosRestantes(calc, async (a) => conteudo[a] ?? null)).toBe(1)
  })

  test("zero quando tudo foi substituído", async () => {
    expect(await contarUsosRestantes(calc, async () => "val a = pricing.calculatePricing(t)")).toBe(0)
  })
})

describe("relatorioDepreciacoes", () => {
  const [calc, fields] = extrairDepreciacoes(SAIDA_KOTLIN, RAIZ)

  test("tudo substituído e compilando fecha com sucesso", () => {
    const limpo = relatorioDepreciacoes([{ familia: calc, estado: "compila", restantes: 0 }], true)
    expect(limpo).toContain("calculatePrice")
    expect(limpo).toContain("substituído (0 usos restantes)")
    expect(limpo).toContain("compila")
  })

  test("sobra de uso vira alerta explícito pedindo 2ª passada", () => {
    const sujo = relatorioDepreciacoes(
      [
        { familia: calc, estado: "compila", restantes: 0 },
        { familia: fields, estado: "compila", restantes: 2 },
      ],
      true,
    )
    expect(sujo).toContain("⚠ 2 uso(s) ainda no código")
    expect(sujo).toContain("segunda passada")
  })

  test("compilação quebrada após substituir é dito na cara", () => {
    const quebrou = relatorioDepreciacoes([{ familia: calc, estado: "compila-falhou", restantes: 0 }], false)
    expect(quebrou).toContain("NÃO compila")
  })
})

describe("comandoWarnings", () => {
  test("gradle: força recompilação com warnings (classes+testClasses, rerun)", () => {
    const c = comandoWarnings("gradle", "./gradlew build")
    expect(c).toContain("./gradlew")
    expect(c).toContain("--rerun-tasks")
    expect(c).not.toContain(" build")
  })

  test("maven compila sem empacotar; ecossistema desconhecido cai no buildCmd", () => {
    expect(comandoWarnings("maven", "./mvnw -q package")).toContain("test-compile")
    expect(comandoWarnings("desconhecido", "make all")).toBe("make all")
  })
})
