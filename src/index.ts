import { ui } from "./terminal/ui"
import { processar, cancelar } from "./agent/agent"
import { Backup } from "./tools/backup"
import { modeloOllama } from "./llm/ollama"
import { provedor } from "./llm/openrouter"
import { carregarContexto } from "./context/projeto"
import { garantirSintese, inicializarProjeto } from "./context/init"
import { custoSessao, custoMes, mesAtual, historicoTarefas } from "./agent/custo"

let encerrando = false
function sair(): never {
  if (!encerrando) {
    encerrando = true
    ui.fechar()
    ui.linhaBranca()
    ui.sucesso("Até logo.")
  }
  process.exit(0)
}

// Ctrl+C: cancela a tarefa em andamento e volta ao prompt; se estiver ocioso, encerra limpo.
process.on("SIGINT", () => {
  if (cancelar()) return
  sair()
})

ui.renderHeader()
void modeloOllama()
void carregarContexto()
void garantirSintese()
try {
  provedor()
} catch {}

function ajuda() {
  ui.subItem("/ajuda    esta ajuda")
  ui.subItem("/init     explora o projeto e cria/atualiza o ARARA.md")
  ui.subItem("/custo    mostra o custo acumulado (sessão e mês)")
  ui.subItem("/undo     reverte a última edição de arquivo")
  ui.subItem("/sair     encerra (ou Ctrl+C)")
  ui.subItem("Ctrl+C durante uma tarefa: cancela e volta ao prompt")
  ui.subItem("qualquer outro texto: o agente lê, edita e roda código pra resolver")
}

while (true) {
  const entrada = await ui.prompt()
  if (entrada === null) break
  const linha = entrada.trim()
  if (!linha) continue
  const cmd = linha.toLowerCase()
  if (cmd === "/sair" || cmd === "/exit") break
  if (cmd === "/ajuda" || cmd === "/help") {
    ajuda()
    continue
  }
  if (cmd === "/init") {
    await inicializarProjeto()
    continue
  }
  if (cmd === "/custo") {
    ui.custo(custoSessao(), await custoMes(), mesAtual())
    ui.custoHistorico(await historicoTarefas())
    continue
  }
  if (cmd === "/undo") {
    const p = await Backup.reverter()
    if (p) ui.sucesso(`revertido: ${p.split("/").pop()}`)
    else ui.info("nada para reverter")
    continue
  }
  if (linha.startsWith("/")) {
    ui.erro(`comando desconhecido: ${linha.split(/\s+/)[0]}`)
    ui.subItem("digite /ajuda pra ver os comandos")
    continue
  }
  await processar(linha)
}

sair()
