# Jade Code

**Coding agent de terminal. A arquitetura é o produto, não o modelo.**

[![CI](https://github.com/ararahq/ararahq-code/actions/workflows/ci.yml/badge.svg)](https://github.com/ararahq/ararahq-code/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%201.3+-black.svg)](https://bun.sh)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

`Bun` · `TypeScript` · `OpenRouter` · open-source (Apache-2.0) · bring your own key

---

A Jade não é mais um wrapper de LLM com tools. É um scaffold determinístico que faz o trabalho **barato** — achar o código certo, montar o contexto, verificar o resultado — **antes** de chamar o modelo. O raciocínio caro acontece isolado, **uma vez**, sobre material já mastigado. É por isso que ela bate de frente com agentes que custam 10x mais: o modelo forte só entra onde modelo forte importa.

> Um agente comum recebe *"o cache não invalida quando o registro é atualizado"*, joga cru no modelo e o deixa caçar o bug com grep no escuro — lento, caro, e termina sugerindo com dúvida. A Jade entrega pro modelo a comparação `[A] updateRecord` vs `[B] readFromCache` já pronta, e ele **crava** causa-raiz com `arquivo:linha` e correção.

---

## Como funciona — as 4 camadas

Cada camada ataca um problema difícil específico de coding agent. Juntas, transformam "modelo com ferramentas" em "arquitetura que pensa".

### Camada 1 — Conhecimento do projeto (`src/conhecimento/`)
Retrieval determinístico, pré-computado, **antes** do modelo.
- **Mapa de símbolos** por regex por-linguagem (não tree-sitter): funções, classes, métodos com range de linhas.
- **Grafo de dependência**: `CHAMA`, `HERDA`, `USA_TIPO`, `IMPORTA`.
- **Stack detector** agnóstico de linguagem (Node, Gradle, Maven, Cargo, Go, Python, PHP, Ruby, .NET, SwiftPM, CMake, Make) com build/test/lint inferidos por subprojeto — alvos de Makefile derivados do próprio arquivo.
- **Símbolos + grafo** cobrem Kotlin, Java, TS/JS, Python, Go, Rust, PHP, Ruby, C, C++, C# e Swift (as linguagens dos ~80% dos repos novos do GitHub).
- **Memória** de bugs e decisões. Reindex incremental por `mtime`/hash. Persistido em `~/.arara/projects/<hash>/`.
- _Medido: 3546 arquivos / 23060 símbolos / 26363 nós em ~1.7s._

### Camada 2 — Montagem de contexto (`src/agent/contexto.ts`)
Converte **"ache o bug"** (problema aberto) em **"compare [A] vs [B]"** (problema fechado).
Usa o grafo da Camada 1 pra parear os pontos relevantes e recortar trechos cirúrgicos por range de símbolo — em vez de despejar arquivos inteiros (ou os arquivos errados) no modelo.

### Camada 3 — Roteamento Jade (`src/agent/router.ts` + `src/engine/marques.ts`)
Decide, **sem chamar modelo**, qual marcha pega cada tarefa:
- **Árvore de decisão (3.0):** stack trace colado → diagnóstico forte · tamanho/escopo grande → loop longo · sintoma sem causa → diagnóstico · instrução cirúrgica → execução · seguimento curto depois de um diagnóstico → **herda** e aplica o diagnóstico anterior.
- **Test-time compute graduado (3.4):** antes de pagar um modelo maior, sobe o _thinking_ no mesmo modelo. Pensar mais é mais barato que um modelo mais caro.
- **Reclassificação dinâmica (3.5):** uma execução que não editou nada e voltou hedge era um diagnóstico disfarçado — pivota pro pipeline de diagnóstico **sem recomeçar**.

### Camada 4 — Verificação e recuperação (`src/agent/camada4.ts` + `recovery.ts`)
As travas que impedem o agente de fazer besteira:
- **Scope guard:** só edita o que foi diagnosticado. Achou outros pontos parecidos? **Lista e pergunta** ("cada um pode ter semântica diferente") em vez de corrigir por conta.
- **Ancoragem no alvo** (`alvo.ts`): "conserta o X do modal de feedback" trava a edição no componente que **você** apontou (termo→arquivo por raridade, zero modelo). Diagnóstico que crava em outro componente desconectado vira **abstenção honesta** ("teu alvo parece correto; achei algo em Y — confirma?") em vez de conserto que ninguém pediu com build verde.
- **Test-gate determinístico:** editou código → o build do subprojeto tocado **precisa** ficar verde antes de declarar pronto.
- **Contorno de ambiente agnóstico:** build falhou por runtime/toolchain incompatível (Java, Node, Python, Go, Rust...) → classifica como ambiente, tenta o contorno (ex.: `JAVA_HOME` compatível) e, se não resolver, **devolve honesto**. Nunca vira loop de `find`/`grep`/`sed`.
- **Trava de trajetória longa:** passou do teto de passos sem fechar → para, resume e devolve, em vez de rodar cego.

---

## Tarefas complexas — o Maestro

Problema complexo **não** é um problema maior — é uma **sequência de problemas médios**, e médio a Jade já resolve bem. Quando o roteador classifica a tarefa como loop longo (escopo/tamanho grande), o **Maestro** (`src/agent/maestro.ts`) entra:

1. **Decompõe** a tarefa em sub-objetivos ordenados e verificáveis (1 passada do modelo forte, saída estruturada).
2. **Executa cada sub-objetivo** na máquina já provada (diagnóstico opcional + edição + portão de build), com **escopo e orçamento de passos próprios**.
3. **Checkpoint entre eles** — se um sub-objetivo trava, para honesto e devolve o mapa (o que ficou pronto, onde travou, o que falta), pronto pra retomar.

O pulo do gato: cada sub-objetivo é uma execução nova, então **a trava de trajetória (16 passos) reseta por sub-objetivo** — 8 sub-objetivos × 16 passos = 128 passos no total, cada um verificado. Tarefa simples gera UM sub-objetivo e passa direto, sem overhead. **Mesmo agente, do trivial ao complexo** — a diferença é orquestração, não um modelo mais esperto.

## Skills — instrução especializada plug-and-play

A Jade aproveita as skills **já instaladas** no formato aberto do Claude (`SKILL.md` com frontmatter `name`/`description` + corpo em markdown) — sem reescrever nada. O pulo do gato é manter a tese: a **seleção é determinística** (Marques, zero modelo) e com **progressive disclosure**.

1. **Descobre** as skills nas raízes, da mais específica pra mais ampla: `.claude/skills/` e `.arara/skills/` do projeto, depois `~/.claude/skills/` e `~/.arara/skills/`, e qualquer pasta extra via `ARARA_SKILLS_DIRS` (pra skills de outro agente/LLM). Mesmo nome: o projeto vence o global.
2. **Ativa** só a(s) skill(s) cuja descrição **casa** com a tarefa, pontuando os termos em comum (`perfilTermos`) — nunca chama modelo pra escolher. Casa contra os **metadados** (nome+descrição), não contra o corpo.
3. **Injeta** apenas o corpo da skill que casou no system prompt (sanitizado, com teto de tamanho). Nenhuma casou? Bloco vazio — zero token desperdiçado.

```bash
/skills                                   # lista o que a Jade descobriu (nome, origem, descrição)
export ARARA_SKILLS_DIRS="/caminho/skills:/outro/caminho"   # skills de fora (ex.: outro LLM)
```

> Skill é a Camada 1/2 aplicada a procedimento: o trabalho barato (achar a instrução certa) acontece antes, sem pagar modelo. O modelo forte recebe o playbook já mastigado em vez de adivinhar o método.

## Jade — as 5 marchas

Cada marcha é um modelo diferente, roteado pela Camada 3 — e isso é **aberto, sem segredo**: os modelos e preços abaixo vêm direto do [`router.ts`](src/agent/router.ts). A tese é que o roteamento + scaffold é o que gera o resultado; trocar um modelo é trocar uma constante, a arquitetura não muda.

| Marcha | Quando | Motor (hoje) | Custo (USD / 1M in·out) |
|---|---|---|---|
| **M1 — trivial** | conversa, meta-pergunta | Ollama local (sem ele, cai no v4-flash) | ~0 (local) |
| **M2 — execução** | instrução cirúrgica pronta | deepseek-v4-flash | 0.09 · 0.18 |
| **M3 — diagnóstico** | sintoma sem causa, stack trace | deepseek-v4-pro | 0.44 · 0.87 |
| **M4 — loop longo** | escopo amplo, multi-arquivo | minimax-m3 (via Maestro: v4-pro planeja, v4-flash executa) | 0.30 · 1.20 |
| **M5 — executar diagnóstico** | aplicar o mastigado da M3 | volta pra M2 | 0.09 · 0.18 |

**Cadeia de escalada do diagnóstico** — só sobe se o degrau de baixo não cravar (`arquivo:linha`, sem hedge), sempre sobre o **mesmo material** já reunido:

```
deepseek-v4-flash -> deepseek-v4-pro -> qwen3.7-plus -> glm-5.2
```

Começa barato e paga o forte só onde forte importa — a maioria das tarefas morre nos dois primeiros degraus. Na tela, as métricas mostram tokens/custo/tempo de cada tarefa; o modelo que cada uma usou fica registrado por tarefa em `~/.arara/custo.json`.

---

## Instalação

**Um comando** (instala o [Bun](https://bun.sh) se faltar e o `jade-code` global — leia o [`install.sh`](install.sh), é curto):

```bash
curl -fsSL https://raw.githubusercontent.com/ararahq/ararahq-code/main/install.sh | bash
```

Ou na mão, se já tem Bun:

```bash
# opção A — comando `jade-code` global, direto do GitHub:
bun add -g github:ararahq/ararahq-code

# opção B — clonar e linkar (bom pra hackear no código):
git clone https://github.com/ararahq/ararahq-code.git
cd ararahq-code && bun install && bun link    # registra o comando `jade-code`

# opção C — binário standalone (sem Bun na máquina alvo):
bun install && bun run build                  # gera ./jade-code
```

## Chave OpenRouter — a SUA chave

O `jade-code` é **bring your own key**: usa a **sua** chave da [OpenRouter](https://openrouter.ai), que **fica só na sua máquina** (`~/.arara/.env`) — nada passa por servidor nosso, você paga só o seu uso. Pegue uma em https://openrouter.ai/keys.

**Primeira vez sem chave? O `jade-code` te pede, você cola, e ele salva.** Não precisa repetir.

Prefere configurar na mão? Qualquer um destes (precedência: **export do shell > `.env` do projeto > `~/.arara/.env`**):

```bash
mkdir -p ~/.arara && echo 'OPENROUTER_API_KEY=sk-or-v1-...' > ~/.arara/.env   # global, 1x
export OPENROUTER_API_KEY="sk-or-v1-..."                                       # no ~/.zshrc
echo 'OPENROUTER_API_KEY=sk-or-v1-...' > .env                                  # no diretório do projeto

export OLLAMA_URL="http://localhost:11434"   # opcional: Ollama local, de graça
```

## Uso

```bash
cd /caminho/do/seu/projeto     # a Jade trabalha na raiz do projeto-alvo
jade-code                      # se instalou global (opção A/B)

# ou rodando do fonte:
bun run src/index.ts           # ou: bun start
```

Exemplos de prompt e a marcha que cada um aciona:

```
"por que o cache não invalida quando o registro muda?"          -> M3 diagnóstico
"adiciona o campo isActive no User.ts"                          -> M2 execução
<cola um stack trace>                                           -> M3 diagnóstico (forte)
"refatora App.tsx, api.ts e db.ts pro novo client"             -> M4 loop longo
"agora aplica isso"   (logo após um diagnóstico)                -> herda e executa
```

---

## Modo autônomo (Devin-mode) — beta

A mesma máquina, sem terminal: a tarefa chega por **WhatsApp, Slack, Discord, Linear ou Jira**, roda num **sandbox efêmero** (nada executa na sua máquina) e volta como **PR no GitHub** + resposta na thread de origem.

```
WhatsApp/Slack/Discord/Linear/Jira
  └─ gateway (assinatura verificada ANTES de persistir) -> fila SQLite (dedupe único)
       └─ despachante -> sandbox (docker local | Fly Machine efêmera)
            └─ clona -> indexa (Camada 1) -> executa (test-gate) -> PR -> callback -> resposta na thread
```

```bash
jade-code --tarefa "conserta o bug X"   # 1 tarefa headless, relatório JSON no stdout, exit 0/1
bun run gateway                          # recebe os webhooks e enfileira
bun run despachante                      # consome a fila e sobe sandboxes
bun run sandbox:build                    # builda a imagem do sandbox (docker)
```

- Convenção de mensagem: `dono/repo: instrução` (sem prefixo cai no `JADE_REPO_PADRAO`).
- **Build/test de verdade em toda linguagem que a Jade ataca.** O test-gate só vale se o toolchain existir onde roda:
  - **CLI local:** usa os toolchains da *sua* máquina (você trabalha em Kotlin → tem o JDK). Funciona pra tudo que você já tem instalado.
  - **Sandbox (cloud):** a imagem (`infra/sandbox/Dockerfile`) traz JDK 17+21, Node+Bun, Python, Go, Rust, PHP, Ruby, .NET e C/C++ (clang+cmake+make) pré-instalados — então builda e testa os 12 tier-1 sem depender da máquina de ninguém. Swift (Linux, pesado) é opt-in: `docker build --build-arg COM_SWIFT=1`.
- Honestidade preservada: build vermelho **não** vira PR "pronto" — vira progresso parcial explícito; diagnóstico sem confiança devolve "não cravei" em vez de editar no escuro.
- Segurança: assinatura constant-time por origem (HMAC Meta/Slack/Linear, Ed25519 Discord, segredo Jira); tokens de plataforma nunca entram no sandbox; `JADE_GIT_TOKEN` é apagado do env antes do agente rodar; comando perigoso é auto-negado sem TTY.
- Config completa comentada no `.env.example` (seção "Autonomous mode").

---

## Estrutura

```
src/
├─ index.ts            entrypoint do CLI (bin: jade-code)
├─ agent/
│  ├─ agent.ts         loop agêntico, pipeline de 2 fases
│  ├─ router.ts        Camada 3 — roteamento, test-time compute, reclassificação
│  ├─ alvo.ts          ancoragem no alvo citado — conserto trava no componente que o usuário apontou
│  ├─ maestro.ts       orquestração de tarefa complexa (decompõe -> executa -> verifica -> checkpoint)
│  ├─ diagnostico.ts   raciocínio single-pass + cadeia de escalada de modelos
│  ├─ contexto.ts      Camada 2 — montagem por comparação pareada
│  ├─ camada4.ts       scope guard, test-gate, contorno de ambiente, trajetória
│  ├─ recovery.ts      escada de erro (código vs ambiente), teto de tentativas
│  ├─ planner.ts       decomposição multi-passo
│  └─ custo.ts         telemetria interna por tarefa
├─ conhecimento/       Camada 1 — índice, grafo, stack, símbolos, memória
├─ skills/             descoberta + ativação determinística de skills (formato Claude)
├─ engine/marques.ts   classificador de modo/sinais (stack trace, tamanho, hedge)
├─ llm/                provedor injetável (OpenRouter default via seam) + Ollama local
├─ autonomo/           executor headless + sandbox (Devin-mode)
├─ gateway/            webhooks assinados (WhatsApp/Slack/Discord/Linear/Jira) + fila SQLite
├─ orquestrador/       despachante + drivers de sandbox (docker | Fly)
├─ entrega/            branch -> commit -> push -> PR (token só via GIT_ASKPASS)
├─ security/sanitize.ts redação de secrets, path safety
├─ terminal/           UI, render de markdown no terminal
└─ tools/              ler, listar, buscar, editar-ancorada, rodar-comando (UI injetada)
```

---

## Segurança

- **Secrets** só via env. O sanitizer redige tokens da saída e **nunca** envia `.env`/`.key`/`.pem` pro modelo.
- **Comandos bloqueados** sempre: `rm -rf`, `sudo`, `curl|sh`, `chmod 777`, `mkfs`, `dd`, redirect pra `/dev` e `/sys`.
- **Confirmação** pra destrutivo/externo: `git push`, `reset --hard`, `clean -f`, `checkout .`, `rm -r`.
- **Path safety:** edição/leitura fora da raiz do projeto é bloqueada.
- **Scope guard + test-gate** (Camada 4) impedem edição fora do diagnóstico e "pronto" com build vermelho.

---

## Decisões de engenharia

O código não tem comentários ([regra do projeto](CONTRIBUTING.md)) — cada decisão **medida**, caminho **refutado** e **armadilha** encontrada vive em [`docs/decisoes.md`](docs/decisoes.md), no formato decisão → evidência. Antes de "melhorar" o roteamento, a navegação ou os prompts, leia lá o que já foi tentado e não pagou.

## Avaliação (eval)

A tese "medir, não sentir" é central. Roteamento e seleção de contexto se medem por um conjunto FIXO de tarefas com gabarito (Tier 1 — grátis, determinístico, sem modelo); o diagnóstico real por um Tier 2 pago (cravou? custo? tempo?), sempre contra um placar-base versionado, separando "errou o contexto" de "errou o raciocínio". O harness de eval e seus fixtures vivem **fora** deste repositório público (referenciam benchmarks internos) — traga os seus próprios casos reais pra medir no seu código.

## Versionamento

- Versão em `jade.version` + `package.json`, **patch por patch** (`0.1.0 -> 0.1.1 -> ... -> 0.1.10 -> 0.2.0`).
- **Toda mudança de versão é commitada e enviada pra `main`.**
- Commits: uma linha, `tipo(escopo): descrição`, presente do indicativo, sem body.

Versão atual: **0.1.42**.

---

## Roadmap

- [x] 5.0 — skills no formato aberto do Claude, com ativação determinística (Marques)
- [x] 4.3 — checkpointing por sub-objetivo em loops longos (Maestro)
- [x] 1.4 — resumos de arquivo extrativos (Marques, zero token, cache por hash)
- [ ] re-medição do corpus com o lineup atual de modelos
- [ ] 2.4 — subagente de busca isolado (adiado: o índice determinístico cobre a maior parte)

---

## Autoria

Feito por **Micael Marques** — [github.com/micaelmrsilva](https://github.com/micaelmrsilva).

## Licença

[Apache-2.0](LICENSE) © 2026 Micael Marques. Veja [`NOTICE`](NOTICE).

**Bring your own key:** o `jade-code` roda com a *sua* `OPENROUTER_API_KEY` (e, opcional, Ollama local) — nenhuma chave vai embutida no código. Você paga só o que consumir no seu provedor. Copie [`.env.example`](.env.example) pra `.env` e preencha.
