#!/usr/bin/env bun
import { ui } from "./terminal/ui"
import { processar, cancelar } from "./agent/agent"
import { Backup } from "./tools/backup"
import { modeloOllama } from "./llm/ollama"
import { carregarContexto } from "./context/projeto"
import { garantirSintese, inicializarProjeto } from "./context/init"
import { custoSessao, custoMes, mesAtual, historicoTarefas } from "./agent/custo"
import { descobrirSkills } from "./skills/skills"
import { carregarConfigGlobal, configurarChave } from "./config/env"

// Config "uma vez": ~/.arara/.env -> process.env (sem sobrescrever export do shell nem .env do cwd).
carregarConfigGlobal()

// Modo autônomo (Devin-mode): `jade-code --tarefa "<instrução>"` roda UMA tarefa sem REPL e imprime
// o relatório JSON no stdout. É a porta usada pelo sandbox; nada interativo acontece neste caminho.
// exit 0 = concluiu (verde/sem-gate/sem-mudanca) · exit 1 = vermelho/erro.
const iTarefa = process.argv.indexOf("--tarefa")
if (iTarefa >= 0) {
  const instrucao = process.argv
    .slice(iTarefa + 1)
    .join(" ")
    .trim()
  if (!instrucao) {
    console.error('uso: jade-code --tarefa "<instrução>"')
    process.exit(2)
  }
  const { executarTarefa } = await import("./autonomo/executor")
  const rel = await executarTarefa(instrucao)
  console.log(JSON.stringify(rel))
  process.exit(rel.estado === "erro" || rel.estado === "vermelho" ? 1 : 0)
}

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
if (!process.env.OPENROUTER_API_KEY) {
  const chave = await configurarChave({ temTTY: Boolean(process.stdin.isTTY), perguntar: ui.perguntar, ui })
  if (chave) process.env.OPENROUTER_API_KEY = chave
}

function ajuda() {
  ui.subItem("/ajuda    esta ajuda")
  ui.subItem("/init     explora o projeto e cria/atualiza o ARARA.md")
  ui.subItem("/skills   lista as skills instaladas que a Jade descobriu")
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
  if (cmd === "/skills") {
    const skills = await descobrirSkills(process.cwd())
    if (!skills.length) {
      ui.info("nenhuma skill encontrada.")
      ui.subItem("instale skills em .claude/skills/, ~/.claude/skills/ ou aponte ARARA_SKILLS_DIRS")
    } else {
      ui.info(`${skills.length} skill(s) instalada(s):`)
      for (const s of skills) ui.subItem(`${s.nome} (${s.origem})${s.descricao ? ` — ${s.descricao}` : ""}`)
    }
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
