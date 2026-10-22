// ACP integration: the disables-skills shadowing mechanism (bundled pptx →
// user pptx skill). Mirrors tests/e2e/tui/skills-disables-skills.test.ts on
// the ACP surface: while skills.pptx is on (its default), the command palette
// and the model-visible system prompt must exclude the shadowed user skill,
// and the Skill tool must refuse it, naming the declarer. A settings override
// restores it. The skill *load* path is surface-independent (shared extension
// code, covered by the TUI e2e and unit tests), so only the advertisement and
// refusal surfaces are pinned here.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { commandNames, newSession, prompt, waitFor } from "./support/scenarios.js"

const USER_DESC = "USER_PPTX_SKILL: python-pptx based deck editing."
const USER_BODY = "OFFICE_PPTX_GUIDANCE: edit decks with python-pptx."
const USER_PDF_DESC = "USER_PDF_SKILL: pypdf based merging."
const USER_DOCX_DESC = "USER_DOCX_SKILL: python-docx based report editing."
const USER_DOCX_BODY = "OFFICE_DOCX_GUIDANCE: edit documents with python-docx."

function seedClaudeSkills(homeDir: string): void {
	const skills: Array<[string, string]> = [
		["pptx", `---\nname: pptx\ndescription: ${USER_DESC}\n---\n# PPTX\n${USER_BODY}\n`],
		["pdf", `---\nname: pdf\ndescription: ${USER_PDF_DESC}\n---\n# PDF\nUse pypdf.\n`],
		["docx", `---\nname: docx\ndescription: ${USER_DOCX_DESC}\n---\n# DOCX\n${USER_DOCX_BODY}\n`],
		[
			"verify-this",
			"---\nname: verify-this\ndescription: Verify a claim with fresh evidence.\n---\n# Verify this\nRestate it falsifiably.\n",
		],
	]
	for (const [name, body] of skills) {
		mkdirSync(join(homeDir, ".claude", "skills", name), { recursive: true })
		writeFileSync(join(homeDir, ".claude", "skills", name, "SKILL.md"), body, "utf-8")
	}
}

/**
 * Wire up both advertisement channels in the shape the real config ships:
 * channel 1 (claude-code-skills extension) needs the session workdir's
 * `.claude` dir — which also registers the Skill tool at session_start — and
 * channel 2 is the configured `skillPaths` entry (".claude/skills" in the
 * real config.json), the channel that leaked before the fix.
 */
function seedBothChannels(fixture: AcpFixture): void {
	mkdirSync(join(fixture.workDir, ".claude"), { recursive: true })
	const configPath = join(fixture.homeDir, ".config", "kimchi", "config.json")
	const config = JSON.parse(readFileSync(configPath, "utf-8")) as { skillPaths?: string[] }
	config.skillPaths = [".claude/skills"]
	writeFileSync(configPath, JSON.stringify(config, null, "\t"), "utf-8")
}

/** Main-conversation chat requests (excludes the session-name extension's call). */
function mainChats(fixture: AcpFixture): Array<{ url: string; body: unknown }> {
	const systemPromptOf = (body: unknown): string => {
		const messages = (body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
		return messages
			.filter((m) => m.role === "system")
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
			.join("\n")
	}
	return fixture.fake.requests
		.filter((r) => r.url.includes("chat/completions"))
		.filter((r) => !systemPromptOf(r.body).includes("Name the user's actual task"))
}

describe("ACP integration — disables-skills shadowing (bundled pptx → user pptx)", () => {
	let fixture: AcpFixture
	const realEnableEnv = process.env.KIMCHI_ENABLE_RESOURCES

	afterEach(async () => {
		if (realEnableEnv === undefined) delete process.env.KIMCHI_ENABLE_RESOURCES
		else process.env.KIMCHI_ENABLE_RESOURCES = realEnableEnv
		await fixture.stop()
	})

	it(
		"skills.pptx on (default): palette and model prompt advertise verify-this and the bundled pptx, not the user skill",
		async () => {
			process.env.KIMCHI_ENABLE_RESOURCES = "extensions.claude-code-skills"
			fixture = await startAcpFixture({
				artifactName: "skills-disables-skills-acp-on",
				responses: [{ stream: ["Skills checked."] }],
				pretrustWorkDir: true,
			})
			seedClaudeSkills(fixture.homeDir)
			seedBothChannels(fixture)

			const sessionId = await newSession(fixture, fixture.workDir)
			const palette = await waitFor(
				() => commandNames(fixture, sessionId),
				(names) => names.some((n) => n.startsWith("skill:")),
			)

			expect(palette, `palette: ${palette.join(",")}`).toContain("skill:pptx")
			expect(palette, `palette: ${palette.join(",")}`).toContain("skill:verify-this")

			// The model-visible prompt over the ACP session excludes the user skill.
			expect(await prompt(fixture, sessionId, "list your skills briefly")).toMatchObject({ stopReason: "end_turn" })
			const first = JSON.stringify(mainChats(fixture)[0]?.body ?? {})
			expect(first).toContain("verify-this")
			expect(first).not.toContain(USER_DESC)
			expect(first).not.toContain(USER_BODY)
		},
		PROMPT_TIMEOUT_MS * 3,
	)

	it(
		"skills.pptx on (default): the Skill tool refuses the shadowed skill naming the declarer",
		async () => {
			process.env.KIMCHI_ENABLE_RESOURCES = "extensions.claude-code-skills"
			fixture = await startAcpFixture({
				artifactName: "skills-disables-skills-acp-refusal",
				responses: [
					{ toolCalls: [{ function: { name: "Skill", arguments: JSON.stringify({ skill: "pptx" }) } }] },
					{ toolCalls: [{ function: { name: "Skill", arguments: JSON.stringify({ skill: "pdf" }) } }] },
					{ toolCalls: [{ function: { name: "Skill", arguments: JSON.stringify({ skill: "docx" }) } }] },
					{ stream: ["Refused as expected."] },
				],
				pretrustWorkDir: true,
			})
			seedClaudeSkills(fixture.homeDir)
			seedBothChannels(fixture)
			const sessionId = await newSession(fixture, fixture.workDir)

			expect(await prompt(fixture, sessionId, "load the pptx skill")).toMatchObject({ stopReason: "end_turn" })

			const chats = mainChats(fixture)
			expect(chats.length).toBeGreaterThanOrEqual(3)
			const second = JSON.stringify(chats[1].body)
			expect(second).toContain("disabled by the enabled")
			// The refusal replaced the user skill body — it never reached the model.
			expect(second).not.toContain(USER_BODY)
			const first = JSON.stringify(chats[0].body)
			expect(first).not.toContain(USER_PDF_DESC)
			expect(first).not.toContain(USER_DOCX_DESC)
			// A same-named user pdf skill is refused by the bundled pdf skill.
			const thirdBody = chats[2].body as { messages?: Array<{ role: string; content: unknown }> }
			const thirdTools = (thirdBody.messages ?? []).filter((m) => m.role === "tool")
			expect(String(thirdTools.at(-1)?.content ?? "")).toContain('disabled by the enabled "pdf" skill')
			// And a same-named user docx skill is refused by the bundled docx skill.
			const fourthBody = chats[3].body as { messages?: Array<{ role: string; content: unknown }> }
			const fourthTools = (fourthBody.messages ?? []).filter((m) => m.role === "tool")
			const docxResult = String(fourthTools.at(-1)?.content ?? "")
			expect(docxResult).toContain('disabled by the enabled "docx" skill')
			expect(docxResult).not.toContain(USER_DOCX_BODY)
		},
		PROMPT_TIMEOUT_MS * 3,
	)

	it(
		"skills.pptx off (settings override): the user pptx skill returns to the palette",
		async () => {
			process.env.KIMCHI_ENABLE_RESOURCES = "extensions.claude-code-skills"
			fixture = await startAcpFixture({
				artifactName: "skills-disables-skills-acp-off",
				responses: [],
				pretrustWorkDir: true,
				settings: { resources: { "skills.pptx": false } },
			})
			seedClaudeSkills(fixture.homeDir)
			seedBothChannels(fixture)
			const sessionId = await newSession(fixture, fixture.workDir)

			// The advertised description (not the colliding skill name) tells the
			// two pptx skills apart: the un-shadowed user skill surfaces again.
			const palette = await waitFor(
				() => commandNames(fixture, sessionId),
				(names) => names.includes("skill:pptx") && names.includes("skill:verify-this"),
			)
			expect(palette, `palette: ${palette.join(",")}`).toContain("skill:pptx")
			expect(palette, `palette: ${palette.join(",")}`).toContain("skill:verify-this")
		},
		STARTUP_TIMEOUT_MS + 30_000,
	)
})
