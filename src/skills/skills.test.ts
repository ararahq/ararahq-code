import { test, expect, describe, afterEach } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { descobrirSkills, selecionarSkills, montarBlocoSkills, resetSkills, expandirTermosLingua } from "./skills"
import { perfilTermos } from "../engine/marques"

describe("skills — ponte de língua PT→EN", () => {
  test("expande termo PT com o equivalente EN, sem perder o PT", () => {
    const exp = expandirTermosLingua(perfilTermos("auditoria de segurança e autenticação"))
    expect(exp.has("segurança")).toBe(true) // mantém PT
    expect(exp.has("security")).toBe(true) // adiciona EN
    expect(exp.has("audit")).toBe(true)
    expect(exp.has("authentication")).toBe(true)
  })

  test("termo sem entrada na ponte fica intacto (não inventa)", () => {
    const exp = expandirTermosLingua(perfilTermos("xyzzy plumbus"))
    expect([...exp.keys()].sort()).toEqual(["plumbus", "xyzzy"])
  })
})

const homeOriginal = process.env.HOME
const dirsOriginal = process.env.ARARA_SKILLS_DIRS
let tmp: string | null = null

afterEach(async () => {
  process.env.HOME = homeOriginal
  if (dirsOriginal === undefined) delete process.env.ARARA_SKILLS_DIRS
  else process.env.ARARA_SKILLS_DIRS = dirsOriginal
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = null
  resetSkills()
})

/** Cria uma skill no formato Claude (pasta/SKILL.md) sob `base/.claude/skills`. */
async function criarSkill(base: string, raizSkills: string, nome: string, frontmatter: string, corpo: string) {
  const dir = join(base, raizSkills, nome)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${corpo}\n`)
}

/** Monta um projeto temporário + HOME temporário isolado, e devolve a raiz do projeto. */
async function cenario(): Promise<{ raiz: string; home: string }> {
  tmp = await mkdtemp(join(tmpdir(), "arara-skills-"))
  const home = join(tmp, "home")
  const raiz = join(tmp, "proj")
  await mkdir(home, { recursive: true })
  await mkdir(raiz, { recursive: true })
  process.env.HOME = home
  delete process.env.ARARA_SKILLS_DIRS
  resetSkills()
  return { raiz, home }
}

describe("skills — descoberta (formato Claude)", () => {
  test("lê SKILL.md de .claude/skills do projeto e do HOME, com name/description do frontmatter", async () => {
    const { raiz, home } = await cenario()
    await criarSkill(raiz, ".claude/skills", "pdf-fill", 'name: pdf-fill\ndescription: Preenche formulários PDF', "Passos: 1. abra o pdf")
    await criarSkill(home, ".claude/skills", "commit-msg", 'name: commit-msg\ndescription: Escreve mensagens de commit', "Use conventional commits")

    const skills = await descobrirSkills(raiz)
    const nomes = skills.map((s) => s.nome).sort()
    expect(nomes).toEqual(["commit-msg", "pdf-fill"])
    expect(skills.find((s) => s.nome === "pdf-fill")?.origem).toBe("claude:projeto")
    expect(skills.find((s) => s.nome === "commit-msg")?.origem).toBe("claude:global")
  })

  test("nome cai pro nome da pasta quando o frontmatter não traz name", async () => {
    const { raiz } = await cenario()
    await criarSkill(raiz, ".claude/skills", "minha-skill", "description: faz algo", "corpo")
    const skills = await descobrirSkills(raiz)
    expect(skills[0]?.nome).toBe("minha-skill")
  })

  test("projeto sobrescreve global no mesmo nome (precedência)", async () => {
    const { raiz, home } = await cenario()
    await criarSkill(raiz, ".claude/skills", "dup", "name: dup\ndescription: versão do projeto", "projeto")
    await criarSkill(home, ".claude/skills", "dup", "name: dup\ndescription: versão global", "global")
    const skills = await descobrirSkills(raiz)
    expect(skills.filter((s) => s.nome === "dup")).toHaveLength(1)
    expect(skills[0]?.corpo).toBe("projeto")
  })

  test("ARARA_SKILLS_DIRS traz skills de outra localização (outro LLM)", async () => {
    const { raiz } = await cenario()
    const externa = join(tmp!, "outro-llm/skills")
    await criarSkill(join(tmp!, "outro-llm"), "skills", "externa", "name: externa\ndescription: skill de fora", "corpo")
    process.env.ARARA_SKILLS_DIRS = externa
    resetSkills()
    const skills = await descobrirSkills(raiz)
    expect(skills.find((s) => s.nome === "externa")?.origem).toBe("extra")
  })

  test("raiz sem skills não crasha — devolve vazio", async () => {
    const { raiz } = await cenario()
    expect(await descobrirSkills(raiz)).toEqual([])
  })
})

describe("skills — seleção determinística (Marques)", () => {
  test("ativa a skill cujos termos da descrição casam com a tarefa", async () => {
    const { raiz } = await cenario()
    await criarSkill(raiz, ".claude/skills", "pdf-fill", "name: pdf-fill\ndescription: Preenche e edita formulários PDF", "corpo pdf")
    await criarSkill(raiz, ".claude/skills", "sql-migra", "name: sql-migra\ndescription: Cria migrações de banco SQL", "corpo sql")

    const sel = await selecionarSkills("preciso preencher um formulário PDF", raiz)
    expect(sel.map((s) => s.nome)).toEqual(["pdf-fill"])
  })

  test("tarefa sem relação não ativa nenhuma skill (limiar protege)", async () => {
    const { raiz } = await cenario()
    await criarSkill(raiz, ".claude/skills", "pdf-fill", "name: pdf-fill\ndescription: Preenche formulários PDF", "corpo")
    const sel = await selecionarSkills("renomeia a variável foo no arquivo bar", raiz)
    expect(sel).toEqual([])
  })

  test("nome citado explicitamente na tarefa ativa por boost", async () => {
    const { raiz } = await cenario()
    await criarSkill(raiz, ".claude/skills", "changelog", "name: changelog\ndescription: gera notas", "corpo changelog")
    const sel = await selecionarSkills("usa a skill changelog agora", raiz)
    expect(sel.map((s) => s.nome)).toContain("changelog")
  })
})

describe("skills — bloco pro prompt", () => {
  test("injeta o corpo da skill ativada e sanitiza secrets", async () => {
    const { raiz } = await cenario()
    await criarSkill(
      raiz,
      ".claude/skills",
      "deploy",
      "name: deploy\ndescription: faz deploy de produção",
      "Rode com api_key=ABCDEFGHIJKLMNOPQRST e siga os passos de deploy",
    )
    const sel = await selecionarSkills("preciso fazer o deploy de produção", raiz)
    const bloco = montarBlocoSkills(sel)
    expect(bloco).toContain("### Skill: deploy")
    expect(bloco).toContain("[REDACTED]")
    expect(bloco).not.toContain("ABCDEFGHIJKLMNOPQRST")
  })

  test("nenhuma skill => bloco vazio (não polui o prompt)", () => {
    expect(montarBlocoSkills([])).toBe("")
  })
})
