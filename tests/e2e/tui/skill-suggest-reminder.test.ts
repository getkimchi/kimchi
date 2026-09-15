import { mkdirSync, writeFileSync } from "node:fs"
import { expect, test } from "@microsoft/tui-test"
import type { FakeOpenAiServer } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const SKILL_NAME = "git-flow-helper"
const SKILL_DESCRIPTION = "Safe and disciplined Git workflow — staging, committing, branching, and hook discipline."

function seedProjectSkill(_homeDir: string, workDir: string): void {
	const skillDir = `${workDir}/.kimchi/skills/${SKILL_NAME}`
	mkdirSync(skillDir, { recursive: true })
	writeFileSync(
		`${skillDir}/SKILL.md`,
		`---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n\n# Git flow helper\n\nWorkflow guidance body.\n`,
	)
}

/** Concatenate every message's text content across all recorded model requests. */
function allRequestText(server: FakeOpenAiServer): string {
	const parts: string[] = []
	for (const request of server.requests) {
		if (!request.body || typeof request.body !== "object") continue
		const messages = (request.body as { messages?: unknown }).messages
		if (!Array.isArray(messages)) continue
		for (const message of messages) {
			if (!message || typeof message !== "object") continue
			const content = (message as { content?: unknown }).content
			if (typeof content === "string") {
				parts.push(content)
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
						parts.push((block as { text: string }).text)
					}
				}
			}
		}
	}
	return parts.join("\n")
}

test("skill suggest reminder is attached when the user prompt matches an installed skill", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "skill-suggest-reminder",
			seedHome: seedProjectSkill,
			responses: [{ stream: ["OK", " — noted."] }],
		},
		async (fixture) => {
			terminal.submit("git commit and push these changes")

			await expect(terminal.getByText("OK — noted.", { full: true })).toBeVisible()

			const requestText = allRequestText(fixture.fake)
			expect(requestText).toContain("<system-reminder>")
			expect(requestText).toContain(SKILL_NAME)
			expect(requestText).toContain("skill_view")
			// The reminder is an existence nudge, not a directive.
			expect(requestText).toContain("your call")

			// The skill_view tool the instructions name must actually be in the
			// request's tool payload — a reminder pointing at a missing tool is
			// worse than none (regression guard for the #235 unwiring).
			const advertisedTools = fixture.fake.requests.flatMap(
				(request) => (request.body as { tools?: Array<{ function?: { name?: string } }> | undefined })?.tools ?? [],
			)
			expect(advertisedTools.some((tool) => tool.function?.name === "skill_view")).toBe(true)
			expect(advertisedTools.some((tool) => tool.function?.name === "skill_manage")).toBe(false)
		},
	)
})

test("no skill reminder is attached when the prompt does not match any skill", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "skill-suggest-no-match",
			seedHome: seedProjectSkill,
			responses: [{ stream: ["Done", " — parser fixed."] }],
		},
		async (fixture) => {
			terminal.submit("fix the failing parser test in the lexer")

			await expect(terminal.getByText("Done — parser fixed.", { full: true })).toBeVisible()

			// The skill itself is advertised in the <available_skills> system-prompt
			// block — so assert on the reminder's distinctive phrasing, which only
			// exists when a suggestion was delivered.
			const requestText = allRequestText(fixture.fake)
			expect(requestText).not.toContain("installed skills appear relevant")
			expect(requestText).not.toContain("Whether to load one is your call")
		},
	)
})
