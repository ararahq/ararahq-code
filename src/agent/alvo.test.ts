import { describe, expect, test } from "bun:test"
import {
  ancorarAlvo,
  notaAncoragem,
  linhasDeImport,
  conectadosPorImport,
  diagnosticoAncoraNoAlvo,
  montarRespostaForaDoAlvo,
} from "./alvo"

// O repo do caso medido: o usuário fala do modal de FEEDBACK; existe um QRCodeModal parecido do lado.
const ARQUIVOS = [
  "components/dashboard/feedback-widget.tsx",
  "components/console/QRCodeModal.tsx",
  "components/dashboard/modal-base.tsx",
  "app/dashboard/page.tsx",
  "lib/api.ts",
  "src/main/kotlin/com/arara/MessageService.kt",
]

describe("ancorarAlvo", () => {
  test("prosa que aponta componente específico ancora no arquivo certo (feedback vence modal por raridade)", () => {
    const alvo = ancorarAlvo("o botão de fechar (X) do modal de feedback não fecha o modal", ARQUIVOS)
    expect(alvo).not.toBeNull()
    expect(alvo?.arquivos).toEqual(["components/dashboard/feedback-widget.tsx"])
    expect(alvo?.termos).toContain("feedback")
  })

  test("citação explícita de arquivo NÃO ancora por prosa — o caminho existente trata", () => {
    expect(ancorarAlvo("conserta o fechar em components/dashboard/feedback-widget.tsx", ARQUIVOS)).toBeNull()
  })

  test("pedido sem termo que case basename não ancora (diagnóstico livre assume)", () => {
    expect(ancorarAlvo("por que o cache invalida errado às vezes?", ARQUIVOS)).toBeNull()
  })

  test("termo comum demais no repo não ancora sozinho (ambíguo)", () => {
    const muitos = Array.from({ length: 8 }, (_, i) => `src/service/pagamento-service-${i}.ts`)
    expect(ancorarAlvo("o service está lento", [...ARQUIVOS, ...muitos])).toBeNull()
  })

  test("empate no topo com poucos arquivos ancora em todos (até 3)", () => {
    const alvo = ancorarAlvo("o modal não abre", ARQUIVOS)
    expect(alvo).not.toBeNull()
    expect(alvo?.arquivos.sort()).toEqual([
      "components/console/QRCodeModal.tsx",
      "components/dashboard/modal-base.tsx",
    ])
  })

  test("lista de arquivos vazia não ancora", () => {
    expect(ancorarAlvo("o modal de feedback não fecha", [])).toBeNull()
  })
})

describe("notaAncoragem", () => {
  test("cita os arquivos do alvo e a instrução de não consertar componente parecido no lugar", () => {
    const nota = notaAncoragem({ termos: ["feedback"], arquivos: ["components/dashboard/feedback-widget.tsx"] })
    expect(nota).toContain("components/dashboard/feedback-widget.tsx")
    expect(nota).toContain("NÃO procure")
    expect(nota).toContain("alvo parece correto")
  })
})

describe("linhasDeImport / conectadosPorImport", () => {
  const widget = [
    'import { useState } from "react"',
    'import { QRCodeModal } from "../console/QRCodeModal"',
    "export function FeedbackWidget() {",
    "  return null",
    "}",
  ].join("\n")
  const solto = ['import { useState } from "react"', "export function Outro() { return null }"].join("\n")

  test("extrai só as linhas de import, minúsculas", () => {
    const linhas = linhasDeImport(widget)
    expect(linhas).toHaveLength(2)
    expect(linhas[1]).toContain("qrcodemodal")
  })

  test("conecta quando A importa B (e na direção inversa)", () => {
    expect(conectadosPorImport(widget, "components/dashboard/feedback-widget.tsx", solto, "components/console/QRCodeModal.tsx")).toBe(true)
    expect(conectadosPorImport(solto, "components/console/QRCodeModal.tsx", widget, "components/dashboard/feedback-widget.tsx")).toBe(true)
  })

  test("NÃO conecta arquivos sem import entre si", () => {
    expect(conectadosPorImport(solto, "components/a.tsx", solto, "components/b.tsx")).toBe(false)
  })

  test("cobre import de Kotlin/Java (basename como token)", () => {
    const kt = "import com.arara.MessageService\n\nclass Consumer {}"
    expect(conectadosPorImport(kt, "src/Consumer.kt", "class MessageService {}", "src/main/kotlin/com/arara/MessageService.kt")).toBe(true)
  })
})

describe("diagnosticoAncoraNoAlvo", () => {
  const alvo = { termos: ["feedback"], arquivos: ["components/dashboard/feedback-widget.tsx"] }
  const conteudos: Record<string, string> = {
    "components/dashboard/feedback-widget.tsx": 'import { useModal } from "../hooks/use-modal"\nexport function FeedbackWidget() {}',
    "components/hooks/use-modal.ts": "export function useModal() {}",
    "components/console/QRCodeModal.tsx": 'import { useState } from "react"\nexport function QRCodeModal() {}',
  }
  const ler = async (arq: string) => conteudos[arq] ?? null

  test("diagnóstico que cita o próprio alvo ancora", async () => {
    const v = await diagnosticoAncoraNoAlvo(alvo, "CAUSA RAIZ — components/dashboard/feedback-widget.tsx:42: onClick não chama close()", ler)
    expect(v.ancorado).toBe(true)
  })

  test("diagnóstico em dependência importada pelo alvo ancora (hook usado pelo componente)", async () => {
    const v = await diagnosticoAncoraNoAlvo(alvo, "CAUSA RAIZ — components/hooks/use-modal.ts:7: setOpen nunca vira false", ler)
    expect(v.ancorado).toBe(true)
  })

  test("diagnóstico em componente DESCONECTADO do alvo é fuga (o caso QRCodeModal)", async () => {
    const v = await diagnosticoAncoraNoAlvo(alvo, "CAUSA RAIZ — components/console/QRCodeModal.tsx:31: falta onClose após salvar", ler)
    expect(v.ancorado).toBe(false)
    if (!v.ancorado) expect(v.foraDoAlvo).toEqual(["components/console/QRCodeModal.tsx"])
  })

  test("diagnóstico sem arquivo citado não bloqueia (o gate de hedge já cuidou)", async () => {
    const v = await diagnosticoAncoraNoAlvo(alvo, "a causa é o estado do componente na linha 12", ler)
    expect(v.ancorado).toBe(true)
  })
})

describe("montarRespostaForaDoAlvo", () => {
  test("diz que o alvo parece correto, que NÃO editou, e pergunta antes de consertar o outro ponto", () => {
    const r = montarRespostaForaDoAlvo(
      { termos: ["feedback"], arquivos: ["components/dashboard/feedback-widget.tsx"] },
      ["components/console/QRCodeModal.tsx"],
      "CAUSA RAIZ — QRCodeModal.tsx:31",
    )
    expect(r).toContain("components/dashboard/feedback-widget.tsx")
    expect(r).toContain("components/console/QRCodeModal.tsx")
    expect(r).toContain("NÃO editei")
    expect(r).toContain("confirma")
    expect(r).toContain("CAUSA RAIZ — QRCodeModal.tsx:31")
  })
})
