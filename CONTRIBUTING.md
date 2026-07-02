# Contribuindo com o Jade Code

Obrigado pelo interesse. O Jade é open-source (Apache-2.0) e contribuição é bem-vinda — do fix de uma linha ao suporte de uma linguagem nova.

## Princípio que rege tudo

**A arquitetura é o produto, não o modelo.** O trabalho barato e determinístico (achar o código, montar contexto, verificar) acontece **antes** de chamar o modelo. Antes de mandar código pro LLM resolver, pergunte: dá pra resolver isso com regex, grafo ou índice? Se dá, é ali que entra.

Corolário prático: **nada chumbado**. Não crie tabela fixa de linguagens/frameworks — derive da estrutura real do repositório-alvo. O stack detector, o mapa de símbolos e as skills são todos agnósticos por desenho.

## Setup

```bash
git clone https://github.com/ararahq/ararahq-code.git
cd ararahq-code
bun install
cp .env.example .env      # cole sua OPENROUTER_API_KEY (bring your own key)
bun start                 # roda o CLI
```

Requer [Bun](https://bun.sh) 1.3+.

## Antes de abrir PR

Rode e deixe **verde**:

```bash
bun test          # suite completa
bun run typecheck # tsc --noEmit, exit 0
```

- **Todo código tem teste.** Feature, fix ou refactor: se você tocou, escreveu ou atualizou teste. Funções puras (parsing, classificação, roteamento) têm unit obrigatório — são a espinha da tese.
- **Regra de ouro:** se você não consegue escrever um teste que falha sem a sua mudança e passa com ela, a mudança não está pronta.
- **Zero comentários no código.** O código se explica por nome e estrutura — se precisou comentar, extraia uma função/constante com nome melhor. Decisão medida, trade-off ou armadilha vai em [`docs/decisoes.md`](docs/decisoes.md) (decisão → evidência), nunca inline. PR com comentário volta.
- Edições cirúrgicas: troque o bloco exato, não reescreva o arquivo.
- Sem `console.log` no código de produção — o `logInterno` (stderr sob `ARARA_DEBUG=1`) é o canal de debug.

## Commits

Uma linha, presente do indicativo, sem emoji: `tipo(escopo): descrição`.
Tipos: `feat | fix | refactor | docs | test | chore | perf | style`.

```
feat(simbolos): add Swift symbol extraction
fix(gate): baseline gate evita imputar quebra pré-existente à edição
```

Branches: `feat/`, `fix/`, `refactor/`, `chore/` em kebab-case. Nunca commite direto na `main`.

## Adicionar uma linguagem ao tier 1

É de propósito barato — o padrão é ~50 linhas:

1. `src/conhecimento/simbolos.ts` — um `Spec` (regex de def de classe/função/import) + entrada em `POR_EXT`.
2. `src/conhecimento/walk.ts` — a extensão em `EXTS_FONTE`.
3. `src/conhecimento/stack.ts` — um `Manifesto` (arquivo de build → comandos build/test/lint) se a linguagem tiver build system próprio.
4. Teste de extração real em `simbolos.test.ts`.

## Segurança

Achou algo sensível (vazamento de secret, injeção)? **Não abra issue pública.** Mande pra micael@ararahq.com.
