# Decisões de engenharia — o porquê que não está no código

Este arquivo guarda as decisões **medidas**, os caminhos **refutados** e as **armadilhas** encontradas em produção/benchmark. O código não tem comentários de propósito ([CONTRIBUTING](../CONTRIBUTING.md)); o racional vive aqui. Formato: decisão → evidência. Não descreve o que o código faz — descreve por que ele é assim e o que **não** tentar de novo.

## Lei da casa

**O modelo barato nunca raciocina no escuro.** Medido: v4-flash decompondo uma frase crua alucinou "não tenho acesso ao código"; o diagnóstico ancorou no nome do tipo (`twilioService` → editou o `TwilioService` de produção) quando o erro era no teste. Todo caminho olha primeiro (roda build, grep, índice) e só então decide. Corolário: erro de compilação já aponta `arquivo:linha` de graça — grep antes de modelo, sempre.

## Roteamento e escalada (router, recovery)

- **Cadeia de diagnóstico começa barata** (v4-flash → v4-pro → qwen3.7-plus → glm-5.2). O barato crava bug simples com contexto bom; o titular é o v4-pro (SWE ~80% por fração do custo dos grandes).
- **Lineup restrito por decisão de produto (02/jul/2026):** só modelos da shortlist OpenRouter do dono + Ollama local. Saíram kimi-k2.6 (loop longo → minimax-m3), gemini-3.1-pro/gpt-5.5/opus-4.8 (topo da cadeia → qwen3.7-plus/glm-5.2); compreender foi pra gemini-2.5-flash-lite (~107 t/s, volume de leitura). **Atenção: todos os números medidos do corpus (cravada 31%, timeout 25%, nav 5/8) são do lineup ANTERIOR — re-medição pendente.** Slugs e preços validados ao vivo na API `/models` na troca.
- **Só escala quando o material justifica (par preciso).** Medido: escalar sobre superfície escopada custa ~60× e **não converte** — variância do modelo, e bug sutil pede par, não dump. Sem par = 1 passada e devolve.
- **Subir thinking no MESMO modelo antes de trocar de modelo** — pensar mais é mais barato que modelo maior.
- **Esforço por degrau:** 1ª passada (barato) = medium — high no barato era lento sem ganhar confiabilidade; escalou = high.
- **Reclassificação (execução→diagnóstico)** dispara quando a execução não editou nada e devolveu hedge. Teto: 3 trocas de marcha ou 6 tentativas globais, o que vier primeiro — oscilar de natureza é sinal de que precisa de humano.
- **3+ intenções numa frase** → pede pra quebrar, não roteia às cegas. Diagnóstico+execução encadeados → diagnóstico SEMPRE primeiro.

## Diagnóstico (diagnostico, contexto, navegador, smells)

- **O truque central:** converter "ache o bug" (pergunta aberta, ruim até pro modelo caro) em "compare [A] vs [B]" (fechada). É o que faz o barato cravar.
- **Nav-first, cadeia como fallback.** A navegação multi-passo tem 0 confiante-errado medido (dois datasets) — quando abstém, a cadeia precisa assume. Resultado medido: estrangeiro 1→5/8 sem derrubar o 8/8 da Arara. Escalar a navegação pro modelo forte foi medido **net-negativo 2×** ($0.117 desperdiçado, 0 cracado).
- **Verificador sintoma→causa é OPT-IN** (`COM_VERIFICADOR=1`). Medido net-negativo no default: a chamada extra taxa latência (→ timeout, que perde a cravada) e ainda false-confirma. Desligá-lo **dobrou** cravou-certo (12%→31%) e cortou timeout (50%→25%). Isolado nos fixtures ele fazia 6/6 — **ganho de componente ≠ ganho de sistema.**
- **Timeout é convertido em abstenção, nunca em perda:** budget interno de tempo no loop de navegação + deadline duro (folga sob o budget externo) forçam a conclusão do parcial ("CAUSA:" ou "NÃO CRAVEI:") antes do abort. Cortar latência foi o 1º ganho end-to-end medido da história do projeto.
- **`ehCravado`/`detectouHedge` toleram formatação.** Exigir que o texto inteiro começe com "CAUSA:" rejeitava acerto com preâmbulo/bold e escalava a cadeia à toa. `arquivo:linha` concreto é o sinal dominante de cravada; ressalva de implementação na seção CORREÇÃO não é hedge (esse falso-positivo descartava diagnóstico certo).
- **O modelo gastava todos os passos em tool-calls e nunca concluía** (texto vazio = "não cravou" sempre) → conclusão final forçada sob o mesmo deadline.
- **Superfície escopada roda 1 rodada só** e suprime o "FALTA: arquivo": o subtree inteiro já está no contexto; pedir mais re-rodava à toa (era o timeout).
- **Locator:** IDF (termo raro pesa mais) + match estrutural (termo no NOME do arquivo/símbolo ×3) + salto de grafo + centralidade. Medido: reach 2→7/8; match estrutural no topo separou os TOP-1 certos dos enterrados — é o gate que libera escalar pro pago; sem ele, shortlist ou abstém. Leituras em lotes paralelos (serial estourava tempo em ~2k arquivos).
- **Smells (anti-padrões por mecanismo):** grep grátis do MECANISMO do sintoma (TODO-que-estoura, dedup, lock, fail-open, SSRF, XSS, timing-compare, wrong-equality, cors-wildcard). Medido: locate top-3 0→4/8 sem custo. **Gateado por linguagem**: `x == "lit"` é bug em Java e correto em Kotlin/Python — o conceito é universal, a assinatura é por extensão (derivada do repo, sem tabela global). Exclui arquivo de teste (todo hit de "segredo" era teste; o top do caso Mutex era `MutexTest.kt` em vez de `Mutex.kt`). Anti-padrão repetido ×N = mais confiança + fix sistêmico. `Objects.equals` excluído do timing-compare (igualdade de entity, não segurança). O elo frágil é o casamento do RELATO (intenção) — é onde mora o risco de overfit.
- **Cache de conteúdo por mtime:** a navegação relia milhares de arquivos a cada grep (~80s/diagnóstico em repo grande). Cache validado por mtime = ~2-3× (84s→37s); `statSync` é ~100× mais barato que reler.
- **Pesos do par (grep legado):** sufixo comum de alvo +4 · intra-arquivo +2 · trecho cita termo do sintoma +3 · nome de método cita entidade +2 · arquivo casa entidade +1. Calibrados pra que o par cujo código fala do sintoma vença o par só estruturalmente parecido.
- **Sinal de guarda universal:** método com catch que escreve estado e não relança = "engole erro em volta de escrita" — anti-padrão que o pareamento por variante de chamada não vê.
- **Monorepo:** sem filtrar pelo escopo citado, a prosa casa centenas de arquivos e o dossiê explode (timeout); sem ranking por domínio (service com operação no grafo > tela de UI), o arquivo-mãe afunda sob frontend e o par certo nunca monta. "cliente" não pode casar "cli" — o segmento contém o token, nunca o contrário.
- **Test-time compute:** geração de candidatos em paralelo (raciocínio puro), verificação SERIAL (aplicar fix mexe no disco; dois candidatos simultâneos corrompem a árvore). Primeiro verde ganha, perdedores revertidos por checkpoint da pilha de backup.
- **Refutados (não tentar de novo sem ângulo novo):** rerank/retrieval barato (regrediu 8→7 na Arara + timeout) · voto/maioria (erro sistemático erra consistente no mesmo arquivo, maioria reforça; 3× latência) · seed/dossiê pré-aberto (top errado afoga o barato; busca livre crava mais) · reflexos/gate-de-invariante no prompt (barato investiga mais → estoura tempo; a thoroughness do agente forte não cabe no budget do barato).

- **Aterramento por depreciação (caso medido no ararahq-api):** "corrige o que está depreciado" com input curto roteava pra execução simples e o teto de 24 passos acabava ANTES da primeira edição (~10 passos só consertando o JDK 25). O tamanho real da tarefa (26 warnings, 8 arquivos) só aparece DEPOIS do build — então o build roda primeiro, as depreciações são extraídas e agrupadas por família (determinístico), o tamanho é anunciado, e cada família ganha passada + gate + orçamento PRÓPRIOS. Verificação final por grep do identificador (à prova de compilação incremental — o build final não reprinta warning de arquivo não recompilado). Índice ausente é criado na hora (o grounding não dispara sem índice — foi por isso que a armadilha "build já verde" não apareceu no teste).
- **Relatório forçado no corte de teto:** quando a passada principal consome os 24 passos, a resposta era o stream truncado no meio da narração. Agora uma passada extra SEM ferramentas força o relatório (descobri/fiz/falta com arquivo:linha).

## Gates e verificação (camada4, baseline, grounding, erros, alvo)

- **As 3 falhas reais que motivaram a Camada 4:** scope creep, seguir editando com build vermelho, erro de ambiente não contornado.
- **Baseline gate:** falha que já existia antes da edição não é culpa da edição (caso real: teste do controller já falhava pelo WIP do usuário). Sutileza: baseline que **não compilava** nunca rodou os testes — falha de teste pós-conserto é `indeterminado` (mascarada, não atribuível), não `piorou`. Falha nova de **compilação** é sempre culpa da edição.
- **Ancoragem no alvo (caso do modal):** a Jade concluiu certo que o alvo estava OK — e consertou um componente parecido que ninguém pediu, declarando verde. O test-gate prova "build passa", não "resolvi o pedido". E "conserta isso" roteia pra EXECUÇÃO (não diagnóstico), então a trava vale nos dois modos. Conexão por import usa token com fronteira — substring pura false-conecta ("a" de `a.tsx` casa dentro de "react").
- **JAVA_HOME:** `-v 17` ANTES de `-v 21` — numa máquina sem o 21 exato, `java_home -v 21` devolve o Java MAIS NOVO (ex.: 25, justamente o incompatível). `export` em vez de prefixo `VAR=x cmd`: o prefixo vale só pro primeiro comando da linha (o `cd`). E `java` solto fica fora do regex de build JVM (é run, não build; casaria prosa).
- **Trava de JAVA_HOME chutado:** o modelo improvisou `/usr/local/opt/openjdk@17` (inexistente) e gastou 40s num build fadado — caminho literal que não existe é devolvido na hora.
- **Instruções de gate não têm cabeçalho "parrotável":** o modelo repetia "PORTÃO VERMELHO" na resposta ao usuário, vazando a maquinaria.
- **Suite cara (gradle/maven/e2e) fora do gate automático** — o build já pega quebra de compilação, que é o que scope creep introduz.
- **Chave de dedup de edição via `JSON.stringify`:** o delimitador NUL antigo deixava o arquivo de estado binário pro git e pro grep.
- **Erro em arquivo de TESTE se conserta no teste**, não no serviço de produção que ele exercita (o caso twilioService).

## Índice e conhecimento (conhecimento/, engine/)

- **`Map` + `Object.create(null)` no índice reverso:** código alheio tem símbolo chamado `constructor`/`toString`/`hasOwnProperty` — num objeto `{}` essas chaves resolvem pro prototype e quebram (`.add` não é função).
- **Grafo conservador vs navegação permissiva:** o grafo só liga o que resolve (nome único em OUTRO arquivo exige alcançável por import — senão `trim()` ligaria a qualquer `const trim` solto). Mas Kotlin/Java same-package **não importa** → grafo estrito dava 0 arestas; a navegação liga por nome único SEM exigir import.
- **C/C++:** protótipo (`int f(int);`) não é definição; `Classe::` fica fora do nome (o grafo casa pelo nome puro); a detecção de stack testa C/C++ POR ÚLTIMO — Makefile costuma ser task-runner em repo de outra linguagem, o manifesto real tem que ganhar.
- **`const X = /regex/` absorvia as linhas seguintes** no range do símbolo — statement único fecha por balanceamento dos delimitadores da própria declaração, não por chave de bloco.
- **Referência de código é agnóstica de extensão:** `nome.ext` com ext começando por letra (2-10 chars) — exclui versões (`1.5`, `3.14`) sem lista fechada. Ausência de extensão conhecida NUNCA significa "não é código" (falha silenciosa piora o roteamento sem alarme). Index-first: token que bate no índice real é referência com confiança alta.
- **Ponte PT→EN é validada contra o vocabulário real do índice** — só entra o alvo que o projeto de fato usa; nada chumbado. Escopo por lista de linguagens foi REMOVIDO (virou casamento do sintoma contra a árvore real de pastas).
- **Resumo de arquivo é extrativo (Marques), zero token** — substituiu o resumo via modelo barato; a "assinatura semântica" basta pro retrieval.

## Skills

- **Termo genérico não ativa skill sozinho:** "faça os testes passarem" ativava `web3-testing` só pela palavra "testing". Ativação exige ≥1 termo ESPECÍFICO em comum; boost de nome só pra token específico. Projeto vence global no dedup por nome.

## Modo autônomo (gateway, orquestrador, entrega, sandbox)

- **Assinatura constant-time SEMPRE antes de persistir.** Formatos por provider: Meta = HMAC-SHA256 do corpo cru · Slack = HMAC de `v0:<ts>:<corpo>` com tolerância anti-replay · Linear = HMAC do corpo · Discord = Ed25519 (chave crua 32 bytes → DER SPKI, que é o que o node:crypto aceita) · Jira não assina — segredo compartilhado na URL, constant-time.
- **`dedupe_key` UNIQUE na fila** mata retry agressivo de provider (Meta retenta muito) sem lógica extra; claim da fila é atômico (uma tarefa nunca sai pra dois workers).
- **Slack/Discord respondem via canal + bot token**, não via response_url/interaction token — esses expiram em 30/15min e a tarefa autônoma dura mais.
- **WhatsApp:** imagem sem legenda → pede o texto (não adivinha). O media id é baixado NO GATEWAY (que tem o token); o sandbox nunca vê token de plataforma.
- **Sandbox:** `JADE_GIT_TOKEN`/`JADE_CALLBACK_SECRET` são lidos e APAGADOS do `process.env` ANTES do agente rodar — código de terceiro (e o modelo, via `env`) não enxerga segredo de plataforma. Só a `OPENROUTER_API_KEY` fica (BYOK do usuário).
- **Token de git só via `GIT_ASKPASS`** (script temporário apagado no fim) — nunca em URL, argv ou log. Branch com slug determinístico + hash da instrução: retry = mesmo branch; 422 "already exists" = idempotência, não erro.
- **Docker: segredos por `--env-file` 0600, nunca `-e KEY=VALUE`** — vaza no `ps` e no histórico. Exit 1 do container = tarefa vermelha que RODOU e reportou (não é falha de infra).
- **Jira Cloud API v3 exige ADF** no corpo do comentário.

## Terminal e execução de comando

- **Headless nunca lê stdin** — container sem TTY trava pra sempre esperando input; `confirmar()` NEGA comando perigoso sem humano.
- **`rodar()` usa process group próprio** e no timeout mata o grupo inteiro (SIGTERM→SIGKILL) — pega o daemon do gradle junto; resolve mesmo se o pipe não fechar.
- **`rg` não expande brace em glob** (`!**/{a,b}/**` não funciona) — um `-g` por diretório.
- **Cursor do terminal nunca fica escondido**, aconteça o que acontecer (restaurado em qualquer saída).

## Restrições arquiteturais assumidas

- **1 tarefa por processo.** O estado de módulo do agent layer (escopo/edições da rodada, recovery, baseline, imagens da tarefa) assume isso; o modo autônomo escala por **processo** (1 sandbox = 1 tarefa). Migrar pra worker-pool in-process exige redesign desse estado — decisão consciente, não esquecimento.
- **Precedência de env:** export do shell > `.env` do cwd (auto-carregado pelo Bun) > `~/.arara/.env`.
- **Persistência de índice/memória/custo é auxiliar:** falha de leitura/escrita degrada (reindexa, no-op), nunca derruba a tarefa.
- **Skills, memória e resumo são auxiliares** — falha neles não derruba o fluxo principal.
