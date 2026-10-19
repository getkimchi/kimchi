/**
 * E2E TUI tests for the `disables-skills` frontmatter mechanism: with the
 * bundled pptx skill enabled (default: skills.pptx is on), it shadows the
 * same-named skill from the Claude Code skills path (~/.claude/skills) —
 * e.g. a synced Anthropic pptx skill whose python-pptx guidance contradicts
 * the bundled no-Python workflow — so it never reaches the model.
 *
 * Covers:
 * - Toggle ON (default): a seeded ~/.claude/skills/pptx is absent from the
 *   skills advertised in the system prompt, while non-conflicting skills
 *   stay; a model attempt to load "pptx" via the Skill tool is refused with
 *   the declarer named, and that refusal reaches the model context.
 * - Toggle OFF (settings override): the user pptx skill is advertised again
 *   (a disabled skill behaves like a build without the feature).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const USER_DESC = "USER_PPTX_SKILL: python-pptx based deck editing."
const USER_BODY = "OFFICE_PPTX_GUIDANCE: edit decks with python-pptx."
const USER_PDF_DESC = "USER_PDF_SKILL: pypdf based merging."

/** Conversation turns only: the fake server also records warmup, title
 * generation, and other aux chat calls. */
function conversationTurns(requests: ReadonlyArray<{ url: string; body: unknown }>) {
	return requests.filter((r) => r.url.includes("chat/completions") && JSON.stringify(r.body).includes("You are Kimchi"))
}

function seedSkills(homeDir: string, workDir: string): void {
	mkdirSync(join(homeDir, ".claude", "skills", "pptx"), { recursive: true })
	writeFileSync(
		join(homeDir, ".claude", "skills", "pptx", "SKILL.md"),
		`---\nname: pptx\ndescription: ${USER_DESC}\n---\n# PPTX\n${USER_BODY}\n`,
		"utf-8",
	)
	mkdirSync(join(homeDir, ".claude", "skills", "pdf"), { recursive: true })
	writeFileSync(
		join(homeDir, ".claude", "skills", "pdf", "SKILL.md"),
		`---\nname: pdf\ndescription: ${USER_PDF_DESC}\n---\n# PDF\nUse pypdf.\n`,
		"utf-8",
	)
	mkdirSync(join(homeDir, ".claude", "skills", "verify-this"), { recursive: true })
	writeFileSync(
		join(homeDir, ".claude", "skills", "verify-this", "SKILL.md"),
		"---\nname: verify-this\ndescription: Verify a claim with fresh evidence.\n---\n# Verify this\nRestate it falsifiably.\n",
		"utf-8",
	)
	// The cwd gate for Claude Code skill discovery: workDir must contain .claude.
	mkdirSync(join(workDir, ".claude"), { recursive: true })
}

test("bundled pptx skill shadows the user pptx skill: unadvertised and refused by name", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "skills-disables-skills-on",
			env: { KIMCHI_ENABLE_RESOURCES: "extensions.claude-code-skills" },
			seedHome: (homeDir, workDir) => seedSkills(homeDir, workDir),
			responses: [
				// Turn 1: the model tries the shadowed user skill.
				{ toolCalls: [{ function: { name: "Skill", arguments: JSON.stringify({ skill: "pptx" }) } }] },
				// Turn 2: also tries the shadowed user pdf skill.
				{ toolCalls: [{ function: { name: "Skill", arguments: JSON.stringify({ skill: "pdf" }) } }] },
				{ stream: ["Understood, using the bundled pptx skill instead."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("rebuild the quarterly deck")
			await waitForText(terminal, "Understood, using the bundled pptx skill instead.")
			trace.step("skill attempt and refusal completed")

			const turns = conversationTurns(fixture.fake.requests)
			expect(turns.length).toBeGreaterThanOrEqual(3)

			// The advertised skill list carries the bundled skills and the
			// non-conflicting Claude Code skill — but not either user skill.
			const first = JSON.stringify(turns[0].body)
			expect(first).toContain("verify-this")
			expect(first).not.toContain(USER_DESC)
			expect(first).not.toContain(USER_PDF_DESC)
			trace.step("system prompt advertises bundled skills + verify-this, not the user pptx/pdf skills")

			// The refusal — not the user skill body — is what reached the model as
			// the Skill tool result.
			const second = turns[1].body as { messages?: Array<{ role: string; content: unknown }> }
			const toolResult = String(second.messages?.find((m) => m.role === "tool")?.content ?? "")
			expect(toolResult).toContain('is unavailable: it is disabled by the enabled "pptx" skill')
			expect(toolResult).not.toContain(USER_BODY)

			// And a same-named user pdf skill is refused by the bundled pdf skill.
			const third = turns[2].body as { messages?: Array<{ role: string; content: unknown }> }
			const thirdTools = (third.messages ?? []).filter((m) => m.role === "tool")
			const pdfToolResult = String(thirdTools.at(-1)?.content ?? "")
			expect(pdfToolResult).toContain('is unavailable: it is disabled by the enabled "pdf" skill')
			trace.step("Skill tool refusals for both declarers reached model context")
		},
	)
})

test("configured skillPaths channel honors disables-skills", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "skills-disables-skills-config-paths",
			env: { KIMCHI_ENABLE_RESOURCES: "extensions.claude-code-skills" },
			seedHome: (homeDir) => {
				// No workDir/.claude here: the claude-code-skills extension's own
				// discovery stays dormant, so ONLY the configured skillPaths channel
				// could advertise the seeded skills — the channel that leaked before
				// the fix (real config.json ships ".claude/skills").
				mkdirSync(join(homeDir, ".claude", "skills", "pptx"), { recursive: true })
				writeFileSync(
					join(homeDir, ".claude", "skills", "pptx", "SKILL.md"),
					`---\nname: pptx\ndescription: ${USER_DESC}\n---\n# PPTX\n${USER_BODY}\n`,
					"utf-8",
				)
				mkdirSync(join(homeDir, ".claude", "skills", "verify-this"), { recursive: true })
				writeFileSync(
					join(homeDir, ".claude", "skills", "verify-this", "SKILL.md"),
					"---\nname: verify-this\ndescription: Verify a claim with fresh evidence.\n---\n# Verify this\nRestate it falsifiably.\n",
					"utf-8",
				)
				const configPath = join(homeDir, ".config", "kimchi", "config.json")
				const config = JSON.parse(readFileSync(configPath, "utf-8")) as { skillPaths?: string[] }
				config.skillPaths = [".claude/skills"]
				writeFileSync(configPath, JSON.stringify(config, null, "\t"), "utf-8")
			},
			responses: [{ stream: ["Skills checked."] }],
		},
		async (fixture, trace) => {
			terminal.submit("list your skills briefly")
			await waitForText(terminal, "Skills checked.")
			trace.step("turn completed over the configured skillPaths channel")

			const turns = conversationTurns(fixture.fake.requests)
			expect(turns.length).toBeGreaterThanOrEqual(1)
			const first = JSON.stringify(turns[0].body)
			expect(first).toContain("verify-this")
			expect(first).not.toContain(USER_DESC)
			trace.step("configured channel advertises verify-this but not the shadowed user pptx skill")
		},
	)
})

test("skills.pptx disabled: the user pptx skill is advertised and loads normally", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "skills-disables-skills-off",
			env: { KIMCHI_ENABLE_RESOURCES: "extensions.claude-code-skills" },
			seedHome: (homeDir, workDir) => {
				seedSkills(homeDir, workDir)
				// skills.pptx defaults on; a user disables it through the same
				// settings override that `kimchi resources disable skills.pptx` writes.
				mkdirSync(join(homeDir, ".config", "kimchi", "harness"), { recursive: true })
				writeFileSync(
					join(homeDir, ".config", "kimchi", "harness", "settings.json"),
					JSON.stringify({ resources: { "skills.pptx": false } }, null, "\t"),
					"utf-8",
				)
			},
			responses: [
				{ toolCalls: [{ function: { name: "Skill", arguments: JSON.stringify({ skill: "pptx" }) } }] },
				{ stream: ["Loaded the deck skill."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("rebuild the quarterly deck")
			await waitForText(terminal, "Loaded the deck skill.")
			trace.step("skill load completed with skills.pptx off")

			const turns = conversationTurns(fixture.fake.requests)
			expect(turns.length).toBeGreaterThanOrEqual(2)

			const first = JSON.stringify(turns[0].body)
			expect(first).toContain(USER_DESC)
			trace.step("system prompt advertises the user pptx skill when skills.pptx is off")

			const second = JSON.stringify(turns[1].body)
			expect(second).toContain(USER_BODY)
			expect(second).not.toContain("is unavailable")
			trace.step("skill body loaded into model context")
		},
	)
})
