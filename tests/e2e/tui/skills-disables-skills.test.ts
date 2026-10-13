/**
 * E2E TUI tests for the `disables-skills` frontmatter mechanism: with the
 * documents extension enabled, a bundled skill can shadow same-named skills
 * from the Claude Code skills path (~/.claude/skills), so the Anthropic
 * office skills (xlsx/pdf/docx/pptx) — whose pip/LibreOffice guidance
 * contradicts the native documents skill — never reach the model.
 *
 * Covers:
 * - Toggle ON: a seeded ~/.claude/skills/xlsx is absent from the skills
 *   advertised in the system prompt, while non-conflicting skills stay; a
 *   model attempt to load "xlsx" via the Skill tool is refused with the
 *   declarer named, and that refusal reaches the model context.
 * - Toggle OFF: xlsx is advertised again and loads normally (a disabled
 *   experimental toggle behaves like a build without the feature).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const XLSX_BODY = "Use openpyxl and pandas to read spreadsheets."

/** Conversation turns only: the fake server also records warmup, title
 * generation, and other aux chat calls. */
function conversationTurns(requests: ReadonlyArray<{ url: string; body: unknown }>) {
	return requests.filter((r) => r.url.includes("chat/completions") && JSON.stringify(r.body).includes("You are Kimchi"))
}

function seedSkills(homeDir: string, workDir: string): void {
	mkdirSync(join(homeDir, ".claude", "skills", "xlsx"), { recursive: true })
	writeFileSync(
		join(homeDir, ".claude", "skills", "xlsx", "SKILL.md"),
		`---\nname: xlsx\ndescription: Office spreadsheet skill.\n---\n# XLSX\n${XLSX_BODY}\n`,
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

test("documents toggle on: xlsx is unadvertised and refused by name", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "skills-disables-skills-on",
			env: { KIMCHI_ENABLE_RESOURCES: "extensions.documents,extensions.claude-code-skills" },
			seedHome: (homeDir, workDir) => seedSkills(homeDir, workDir),
			responses: [
				// Turn 1: the model tries the disabled Anthropic office skill.
				{ toolCalls: [{ function: { name: "Skill", arguments: JSON.stringify({ skill: "xlsx" }) } }] },
				{ stream: ["Understood, using the documents path instead."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("open the quarterly spreadsheet")
			await waitForText(terminal, "Understood, using the documents path instead.")
			trace.step("skill attempt and refusal completed")

			const turns = conversationTurns(fixture.fake.requests)
			expect(turns.length).toBeGreaterThanOrEqual(2)

			// The advertised skill list carries the bundled documents skill and the
			// non-conflicting Claude Code skill — but not the shadowed xlsx.
			const first = JSON.stringify(turns[0].body)
			expect(first).toContain("documents")
			expect(first).toContain("verify-this")
			expect(first).not.toContain("xlsx")
			trace.step("system prompt advertises documents + verify-this, not xlsx")

			// The refusal — not the skill body — is what reached the model as the
			// Skill tool result.
			const second = turns[1].body as { messages?: Array<{ role: string; content: unknown }> }
			const toolResult = String(second.messages?.find((m) => m.role === "tool")?.content ?? "")
			expect(toolResult).toContain('is unavailable: it is disabled by the enabled "documents" skill')
			expect(toolResult).not.toContain(XLSX_BODY)
			trace.step("Skill tool refusal reached model context")
		},
	)
})

test("configured skillPaths channel honors disables-skills (toggle on)", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "skills-disables-skills-config-paths",
			env: { KIMCHI_ENABLE_RESOURCES: "extensions.documents,extensions.claude-code-skills" },
			seedHome: (homeDir) => {
				// No workDir/.claude here: the claude-code-skills extension's own
				// discovery stays dormant, so ONLY the configured skillPaths channel
				// could advertise the seeded skills — the channel that leaked before
				// the fix (real config.json ships ".claude/skills").
				mkdirSync(join(homeDir, ".claude", "skills", "xlsx"), { recursive: true })
				writeFileSync(
					join(homeDir, ".claude", "skills", "xlsx", "SKILL.md"),
					`---\nname: xlsx\ndescription: Office spreadsheet skill.\n---\n# XLSX\n${XLSX_BODY}\n`,
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
			expect(first).not.toContain("xlsx")
			trace.step("configured channel advertises verify-this but not shadowed xlsx")
		},
	)
})

test("documents toggle off: xlsx is advertised and loads normally", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "skills-disables-skills-off",
			env: { KIMCHI_ENABLE_RESOURCES: "extensions.claude-code-skills" },
			seedHome: (homeDir, workDir) => seedSkills(homeDir, workDir),
			responses: [
				{ toolCalls: [{ function: { name: "Skill", arguments: JSON.stringify({ skill: "xlsx" }) } }] },
				{ stream: ["Loaded the spreadsheet skill."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("open the quarterly spreadsheet")
			await waitForText(terminal, "Loaded the spreadsheet skill.")
			trace.step("skill load completed with toggle off")

			const turns = conversationTurns(fixture.fake.requests)
			expect(turns.length).toBeGreaterThanOrEqual(2)

			const first = JSON.stringify(turns[0].body)
			expect(first).toContain("xlsx")
			trace.step("system prompt advertises xlsx when the toggle is off")

			const second = JSON.stringify(turns[1].body)
			expect(second).toContain(XLSX_BODY)
			expect(second).not.toContain("is unavailable")
			trace.step("skill body loaded into model context")
		},
	)
})
