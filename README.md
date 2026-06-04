# Arara Code

**Coding agent de terminal. A arquitetura é o produto, não o modelo.**

`Bun` · `TypeScript` · `OpenRouter` · privado/interno AraraHQ

---

A Jade não é mais um wrapper de LLM com tools. É um scaffold determinístico que faz o trabalho **barato** — achar o código certo, montar o contexto, verificar o resultado — **antes** de chamar o modelo. O raciocínio caro acontece isolado, **uma vez**, sobre material já mastigado. É por isso que ela bate de frente com agentes que custam 10x mais: o modelo forte só entra onde modelo forte importa.

> Um agente comum recebe *"os números compartilhados estão sendo salvos como dedicados"*, joga cru no modelo e o deixa caçar o bug com grep no escuro — lento, caro, e termina sugerindo com dúvida. A Jade entrega pro modelo a comparação `[A] resolveSender` vs `[B] assignSharedNumber` já pronta, e ele **crava** causa-raiz com `arquivo:linha` e correção.

---

## Como funciona — as 4 camadas

Cada camada ataca um problema difícil específico de coding agent. Juntas, transformam "modelo com ferramentas" em "arquitetura que pensa".

### Camada 1 — Conhecimento do projeto (`src/conhecimento/`)
Retrieval determinístico, pré-computado, **antes** do modelo.
- **Mapa de símbolos** por regex por-linguagem (não tree-sitter): funções, classes, métodos com range de linhas.
- **Grafo de dependência**: `CHAMA`, `HERDA`, `USA_TIPO`, `IMPORTA`.
- **Stack detector** agnóstico de linguagem (Node, Gradle, Maven, Cargo, Go, Python, PHP, Ruby, .NET) com build/test/lint inferidos por subprojeto.
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

## Jade — as 5 marchas

O usuário **sempre vê só "Jade"**. Por baixo, cada marcha é um modelo diferente, roteado pela Camada 3. A façade é parte do produto.

| Marcha | Quando | Motor | Custo (USD / 1M in·out) |
|---|---|---|---|
| **M1 — trivial** | conversa, meta-pergunta | Ollama local | ~0 |
| **M2 — execução** | instrução cirúrgica pronta | deepseek-v3.2 | 0.28 · 0.42 |
| **M3 — diagnóstico** | sintoma sem causa, stack trace | gemini-3.1-pro-preview | 2.0 · 12.0 |
| **M4 — loop longo** | escopo amplo, multi-arquivo | kimi-k2.6 | 0.68 · 3.42 |
| **M5 — executar diagnóstico** | aplicar o mastigado da M3 | volta pra M2 | 0.28 · 0.42 |

**Cadeia de fallback invisível do diagnóstico:** se a M3 não cravar (sem `arquivo:linha`, linguagem hedge), o **mesmo material** é repassado pro próximo modelo — gemini → gpt-5.5 → opus — uma passada cada. O usuário continua vendo só "Jade · diagnóstico".

> **Regra de ouro:** o nome do modelo, o thinking e a marcha **nunca** vazam pro usuário final. Métricas na tela mostram só tokens/custo/tempo; o modelo real fica no log interno.

---

## Quickstart

```bash
# 1. dependências
bun install

# 2. a única env obrigatória
export OPENROUTER_API_KEY="sk-or-..."        # https://openrouter.ai/keys
# opcional: Ollama pra conversa/trivial local e grátis
export OLLAMA_URL="http://localhost:11434"   # default

# 3. roda na RAIZ do projeto que a Jade vai trabalhar
bun run src/index.ts        # ou: bun start

# binário standalone (sem Bun na máquina alvo)
bun run build               # gera ./arara
```

Exemplos de prompt e a marcha que cada um aciona:

```
"por que o número compartilhado está salvando como dedicado?"   -> M3 diagnóstico
"adiciona o campo isActive no User.ts"                          -> M2 execução
<cola um stack trace>                                           -> M3 diagnóstico (forte)
"refatora App.tsx, api.ts e db.ts pro novo client"             -> M4 loop longo
"agora aplica isso"   (logo após um diagnóstico)                -> herda e executa
```

---

## Estrutura

```
src/
├─ index.ts            entrypoint do CLI (bin: arara)
├─ agent/
│  ├─ agent.ts         loop agêntico, pipeline de 2 fases, fachada Jade
│  ├─ router.ts        Camada 3 — roteamento, test-time compute, reclassificação
│  ├─ maestro.ts       orquestração de tarefa complexa (decompõe -> executa -> verifica -> checkpoint)
│  ├─ diagnostico.ts   raciocínio single-pass + cadeia de fallback invisível
│  ├─ contexto.ts      Camada 2 — montagem por comparação pareada
│  ├─ camada4.ts       scope guard, test-gate, contorno de ambiente, trajetória
│  ├─ recovery.ts      escada de erro (código vs ambiente), teto de tentativas
│  ├─ planner.ts       decomposição multi-passo
│  └─ custo.ts         telemetria interna por tarefa
├─ conhecimento/       Camada 1 — índice, grafo, stack, símbolos, memória
├─ engine/marques.ts   classificador de modo/sinais (stack trace, tamanho, hedge)
├─ llm/                provedores OpenRouter + Ollama
├─ security/sanitize.ts redação de secrets, path safety
├─ terminal/           UI, render de markdown no terminal
└─ tools/              ler, listar, buscar, editar-ancorada, rodar-comando
```

---

## Segurança

- **Secrets** só via env. O sanitizer redige tokens da saída e **nunca** envia `.env`/`.key`/`.pem` pro modelo.
- **Comandos bloqueados** sempre: `rm -rf`, `sudo`, `curl|sh`, `chmod 777`, `mkfs`, `dd`, redirect pra `/dev` e `/sys`.
- **Confirmação** pra destrutivo/externo: `git push`, `reset --hard`, `clean -f`, `checkout .`, `rm -r`.
- **Path safety:** edição/leitura fora da raiz do projeto é bloqueada.
- **Scope guard + test-gate** (Camada 4) impedem edição fora do diagnóstico e "pronto" com build vermelho.

---

## Avaliação (eval)

Conjunto de tarefas FIXO com gabarito — pra "melhorou" virar número, não sensação. Dois níveis:

```bash
bun run eval               # Tier 1 (grátis): roteamento + seleção de contexto (sem modelo)
bun run eval -- --full     # Tier 2 (pago): diagnóstico real — cravou? custo? tempo? (precisa de key)
bun run eval -- --salvar   # grava o resultado atual como placar-base (referência)
```

Toda mudança no agente: roda o conjunto, compara com `eval/placar-base.json`. O Tier 1 mede a maior alavanca (seleção de contexto) sem gastar key — e separa "errou o contexto" de "errou o raciocínio". Casos de diagnóstico apontam pra um **fixture congelado** (`eval/fixtures/`) pra serem reproduzíveis mesmo depois do bug ser corrigido no código vivo. Adicione os seus 15-20 casos reais em `eval/casos.ts`.

## Versionamento

- Versão em `jade.version` + `package.json`, **patch por patch** (`0.1.0 -> 0.1.1 -> ... -> 0.1.10 -> 0.2.0`).
- **Toda mudança de versão é commitada e enviada pra `main`.**
- Commits: uma linha, `tipo(escopo): descrição`, presente do indicativo, sem body.

Versão atual: **0.1.15**.

---

## Roadmap

- [ ] 2.4 — subagente de busca isolado
- [ ] 4.3 — checkpointing por sub-objetivo em loops longos
- [ ] 1.4 — geração de resumos de arquivo sob demanda
