// Conjunto de avaliação FIXO. Cada caso tem gabarito conhecido. Toda mudança no agente roda este
// conjunto e compara com o placar-base — "melhorou" vira número, não sensação.
//
//   bun run eval                 # Tier 1 (grátis): roteamento + seleção de contexto
//   bun run eval -- --full       # Tier 2 (pago): diagnóstico real (cravou/custo/tempo)
//   bun run eval -- --salvar     # grava o resultado atual como placar-base
//
// COMO CRESCER: o valor do conjunto vem de TER 15-20 casos reais com gabarito que você conhece.
// O bloco do fim marca onde adicionar os seus. Quanto mais casos de diagnóstico com `cravouSe` e
// `arquivosEsperados`, mais o placar separa "errou o contexto" de "errou o raciocínio".

export type Marcha = "execucao" | "diagnostico" | "conversa" | "loop-longo"

export type Caso = {
  id: string
  prompt: string
  // Raiz do código pra este caso. Default = monorepo. Casos de diagnóstico apontam pra um FIXTURE
  // congelado (estado bugado) pra serem reproduzíveis — não dependem do código vivo, que muda quando
  // o próprio agente corrige o bug. Caminho relativo à pasta eval/.
  raiz?: string
  // Tier 1 — roteamento (determinístico, grátis): marcha que o roteador DEVE escolher.
  marchaEsperada?: Marcha
  // Tier 1 — seleção de contexto (determinístico, grátis): substrings de caminho que o pacote DEVE
  // conter (mede a alavanca nº1 — "o contexto certo estava no pacote?" — sem gastar key).
  arquivosEsperados?: string[]
  // Tier 1 — comparação pareada: substrings que ALGUM par montado DEVE conter (método ou chamada).
  paresEsperados?: string[]
  // Tier 2 — diagnóstico real (pago, --full): padrões que o texto DEVE conter pra "cravar".
  cravouSe?: RegExp[]
}

export const CASOS: Caso[] = [
  // ---- Roteamento puro (grátis, sem índice) ---------------------------------
  { id: "rota-exec-campo", prompt: "adiciona o campo isActive no arquivo User.ts", marchaEsperada: "execucao" },
  { id: "rota-exec-renomeia", prompt: "renomeia a função getUser pra fetchUser no UserService.kt", marchaEsperada: "execucao" },
  { id: "rota-diag-numero", prompt: "por que o número compartilhado está sendo salvo como dedicado?", marchaEsperada: "diagnostico" },
  { id: "rota-diag-lento", prompt: "o endpoint de listagem de campanhas está lento, descobre por quê", marchaEsperada: "diagnostico" },
  {
    id: "rota-stacktrace",
    prompt: "deu pau:\nException in thread \"main\"\n\tat com.arara.api.Foo.bar(Foo.kt:42)\n\tat com.arara.api.Baz.qux(Baz.kt:13)",
    marchaEsperada: "diagnostico",
  },
  { id: "rota-conversa", prompt: "oi, tudo bem?", marchaEsperada: "conversa" },
  { id: "rota-loop-longo", prompt: "refatora os arquivos App.tsx, api.ts, db.ts e auth.ts pra usar o novo cliente http", marchaEsperada: "loop-longo" },

  // ---- Flagship: o bug dos números (roteamento + contexto + diagnóstico) -----
  {
    id: "numero-compartilhado-dedicado",
    prompt: "os números compartilhados estão sendo salvos como dedicados. acha a causa e corrige.",
    raiz: "fixtures/numero",
    marchaEsperada: "diagnostico",
    arquivosEsperados: ["AraraPhoneNumberService.kt"],
    paresEsperados: ["findFirstByIsActiveTrue"],
    cravouSe: [/AraraPhoneNumberService\.kt/i, /findFirstByOrganizationIdIsNullAndIsActiveTrue/i],
  },

  // ====== ADICIONE AQUI seus casos reais do monorepo (gabarito que VOCÊ conhece) =============
  // Diagnóstico (mede contexto grátis + raciocínio pago):
  //   { id: "ctx-<curto>", prompt: "<sintoma como o usuário descreveria>",
  //     marchaEsperada: "diagnostico",
  //     arquivosEsperados: ["<ArquivoOndeMoraACausa>.kt"],
  //     cravouSe: [/<ArquivoOndeMoraACausa>\.kt/i, /<trecho da correção certa>/i] },
  // Execução (mede só roteamento, grátis):
  //   { id: "exec-<curto>", prompt: "<instrução cirúrgica>", marchaEsperada: "execucao" },
]
