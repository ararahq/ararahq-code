#!/usr/bin/env bash
# Instalador do jade-code — https://github.com/ararahq/ararahq-code
#
#   curl -fsSL https://raw.githubusercontent.com/ararahq/ararahq-code/main/install.sh | bash
#
# O que ele faz (e só isso):
#   1. instala o Bun se não existir (runtime do jade-code)
#   2. instala o pacote global `jade-code` direto do GitHub
#   3. te diz o próximo passo (a SUA OPENROUTER_API_KEY — nada de chave embutida)
set -euo pipefail

# Sobrescrevível pra fork/teste: JADE_REPO=git+ssh://git@github.com/voce/seu-fork.git
REPO="${JADE_REPO:-github:ararahq/ararahq-code}"

diga() { printf '\033[36m[jade-code]\033[0m %s\n' "$1"; }

# 1. Bun (https://bun.sh) — instala só se faltar; nunca mexe no que já existe.
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
  else
    diga "Bun não encontrado — instalando (runtime do jade-code)…"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
fi

# 2. O pacote global, direto do GitHub (sempre a main mais recente).
diga "instalando jade-code…"
bun add -g "$REPO"

# 3. Próximos passos, honestos: bring your own key.
BIN_DIR="$(dirname "$(command -v jade-code 2>/dev/null || echo "$HOME/.bun/bin/jade-code")")"
diga "pronto! instalado em ${BIN_DIR}/jade-code"
if ! command -v jade-code >/dev/null 2>&1; then
  diga "adicione ao PATH (e reabra o shell): export PATH=\"\$HOME/.bun/bin:\$PATH\""
fi
diga 'próximo passo: cd no seu projeto e rode `jade-code`.'
diga "na primeira vez ele pede sua OPENROUTER_API_KEY (https://openrouter.ai/keys) e salva em ~/.arara/.env — a chave é sua, fica na sua máquina."
