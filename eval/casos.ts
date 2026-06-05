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

export type Marcha = "execucao" | "diagnostico" | "conversa" | "loop-longo" | "compreender" | "planejar" | "comunicar"

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

  // ---- Copiloto: roteamento das capacidades de leitura (grátis) -------------
  { id: "rota-compreender", prompt: "me explica como funciona o fluxo de autenticação desse projeto", marchaEsperada: "compreender" },
  { id: "rota-planejar", prompt: "como eu faria pra migrar o billing pro novo provider? monta um plano", marchaEsperada: "planejar" },
  { id: "rota-comunicar", prompt: "escreve o commit e a descrição do PR dessa mudança", marchaEsperada: "comunicar" },

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

  // ====== Casos reais (sintoma LEIGO, zero dica de arquivo) — fixtures congeladas dos repos =======
  // Cada um: sintoma como o usuário reportaria + gabarito (arquivo onde mora a causa + cravouSe).
  // Tier 2 mede se o agente vai do sintoma até a causa sozinho. Fixtures copiadas read-only dos repos.

  // -- Tier 0/1: SDKs (claro, mas "parece certo") --
  {
    id: "py-baseurl",
    prompt: "instalei a lib de python de vocês e não funciona nada, todo cliente que usa python dá erro de conexão. no node funciona normal.",
    raiz: "fixtures/py-baseurl",
    marchaEsperada: "diagnostico",
    arquivosEsperados: ["config.py"],
    cravouSe: [/config\.py/i, /(arara\.io|base_url|dom[ií]nio|url)/i],
  },
  {
    id: "py-import-morto",
    prompt: "cliente novo de python não consegue nem começar, dá erro na hora que importa a lib, antes de chamar qualquer coisa. fala algo de pydantic.",
    raiz: "fixtures/py-import",
    marchaEsperada: "diagnostico",
    arquivosEsperados: ["client.py"],
    cravouSe: [/client\.py/i, /(parse_obj_as|pydantic|import)/i],
  },
  {
    id: "php-templates-recursao",
    prompt: "o pessoal do php fala que quando lista ou pega um template o negócio trava e estoura memória. parece um loop sem fim.",
    raiz: "fixtures/php-templates",
    marchaEsperada: "diagnostico",
    arquivosEsperados: ["Templates.php"],
    cravouSe: [/Templates\.php/i, /(recurs|loop|infinit|stack|sombr|shadow|parent::|si mesm)/i],
  },

  // -- Tier 3: dinheiro/segurança (multi-hop, os discriminadores) --
  {
    id: "twilio-estorno-multiplo",
    prompt: "tá aparecendo crédito do nada na carteira de uns clientes. parece que é quando as mensagens falham — quanto mais falha, mais sobe o saldo.",
    raiz: "fixtures/twilio-refund",
    marchaEsperada: "diagnostico",
    arquivosEsperados: ["TwilioWebhookService.kt"],
    cravouSe: [/(TwilioWebhookService|WalletService)\.kt/i, /(refund|estorn|idempot|FAILED|dedup|duas vezes)/i],
  },
  {
    id: "stripe-credito-dobrado",
    prompt: "uns clientes reclamando que recarregaram uma vez só e o saldo veio dobrado, paguei 100 e caiu 200. não é todo mundo, parece aleatório.",
    raiz: "fixtures/stripe-credit",
    marchaEsperada: "diagnostico",
    arquivosEsperados: ["StripeService.kt"],
    cravouSe: [/(StripeService|WalletService)\.kt/i, /(idempot|dedup|dobr|reentreg|session|addCredit|unique)/i],
  },
  {
    id: "welcome-bonus-rollback",
    prompt: "cliente paga na abacate ou no stripe e às vezes não cai o crédito, a conta nem ativa. tá pago no provider, mas do nosso lado não entrou.",
    raiz: "fixtures/welcome-bonus",
    marchaEsperada: "diagnostico",
    arquivosEsperados: ["WalletService.kt"],
    cravouSe: [/WalletService\.kt/i, /(transactional|rollback|requires_new|engol|catch|unexpectedrollback)/i],
  },
  {
    id: "webhook-timing-secret",
    prompt: "recebi email de um pesquisador: dá pra adivinhar o secret do webhook de vocês medindo o tempo de resposta, ele compara byte a byte. procede?",
    raiz: "fixtures/webhook-timing",
    marchaEsperada: "diagnostico",
    arquivosEsperados: ["AbacatePayWebhookController.kt"],
    cravouSe: [/(AbacatePayWebhookController|MetaWebhookController)\.kt/i, /(constant|timing|messagedigest|isequal|tempo|byte)/i],
  },
]
