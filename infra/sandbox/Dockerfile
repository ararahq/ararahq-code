# Sandbox efêmero do Jade Code (Devin-mode). Precisa BUILDAR e TESTAR de verdade toda linguagem que a
# Jade ataca — não basta detectar o comando de teste, o toolchain tem que estar aqui. Por isso é uma
# imagem "gorda": JDK (17+21), Node+Bun, Python, Go, Rust, PHP, Ruby, .NET, C/C++ (clang+cmake+make).
# Swift (Linux, pesado) fica atrás de ARG — ligue com --build-arg COM_SWIFT=1 se atacar Swift no server.
#
# Build (na raiz do repo):  docker build -f infra/sandbox/Dockerfile -t jade-sandbox .
# A env chega em runtime (JADE_TAREFA_JSON, JADE_GIT_TOKEN, OPENROUTER_API_KEY, JADE_CALLBACK_*).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

# Base + toolchains apt: JDK 17 E 21 (o Gradle toolchain escolhe a versão que o projeto exige),
# Python, PHP, Ruby, C/C++ (build-essential+clang+cmake), git/ripgrep/curl. Sem recommends pra enxugar.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep unzip xz-utils \
      openjdk-17-jdk-headless openjdk-21-jdk-headless \
      python3 python3-pip python3-venv \
      php-cli composer \
      ruby ruby-dev \
      build-essential clang cmake make pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Ferramentas Python de teste/lint mais comuns (o stack detector infere pytest/ruff).
RUN pip3 install --no-cache-dir --break-system-packages pytest ruff

# Node 22 (npm/pnpm/yarn) + Bun (o próprio agente roda em Bun, e projetos JS precisam do runtime).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm yarn
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Go (tarball oficial — apt costuma ficar velho).
ARG GO_VERSION=1.24.0
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-$(dpkg --print-architecture).tar.gz" \
      | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"

# Rust (rustup, canal stable).
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# .NET SDK (C#).
RUN curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel LTS --install-dir /usr/local/dotnet
ENV PATH="/usr/local/dotnet:${PATH}"
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1

# Swift no Linux é pesado (~1GB) e de baixa frequência no server — opt-in.
ARG COM_SWIFT=0
RUN if [ "$COM_SWIFT" = "1" ]; then \
      curl -fsSL https://download.swift.org/swiftly/linux/swiftly-$(dpkg --print-architecture).tar.gz \
        | tar -C /usr/local/bin -xz && swiftly init --assume-yes --skip-install || true ; \
    fi

WORKDIR /app
COPY package.json bun.lock jade.version ./
RUN bun install --frozen-lockfile --production
COPY src ./src

ENTRYPOINT ["bun", "run", "/app/src/autonomo/sandbox.ts"]
