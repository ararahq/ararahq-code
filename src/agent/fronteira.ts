// ⚠️ EXPERIMENTAL / LOCAL — NÃO COMMITAR, NÃO SUBIR PRA PRODUÇÃO.
// Modo "fronteira": desliga os FREIOS DE INTELIGÊNCIA (as travas de "eu não posso fazer isso") pra
// medir até onde o modelo cru vai sem a arquitetura determinística segurando: trava de escopo, gate de
// abstenção ("não cravei"), tetos de iteração/investigação/recovery, limites de leitura/busca, bloqueio
// de ação repetida. NÃO desliga a segurança dura (rm -rf, sudo, mkfs, dd, force-push) — isso não é
// fronteira de tech, é não-destruir-a-máquina.
//
// Ativado SÓ por flag explícita (`--fronteira` no CLI) ou env `JADE_FRONTEIRA=1`. Jamais setar no
// sandbox/gateway. Pra remover tudo depois: `git checkout -- .` e apague este arquivo.

let _fronteira = process.env.JADE_FRONTEIRA === "1"

export function ativarFronteira(): void {
  _fronteira = true
}

export function fronteiraAtiva(): boolean {
  return _fronteira
}

/** Teto numérico ampliado quando a fronteira está ativa (senão, o teto normal). */
export function tetoFronteira(normal: number, ampliado: number): number {
  return _fronteira ? ampliado : normal
}
