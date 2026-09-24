import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripFrontmatter } from "@earendil-works/pi-coding-agent"
import { expect, test } from "@microsoft/tui-test"
import { REPO_ROOT, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("a user can invoke the bundled skill creator without installing skills", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "create-skill",
			responses: [{ stream: ["Let's create your meeting follow-up skill."] }],
		},
		async (fixture, trace) => {
			terminal.submit("/skill:create-skill Turn meeting notes into action items")
			trace.step("invoked bundled creator")

			await expect(terminal.getByText("Let's create your meeting follow-up skill.", { full: true })).toBeVisible()
			trace.step("creator request answered")

			const request = fixture.fake.requests.find((item) => item.url.startsWith("/openai/v1/chat/completions"))
			expect(request).toBeDefined()
			const body = JSON.stringify(request?.body)
			const skill = readFileSync(join(REPO_ROOT, "resources/skills/create-skill/SKILL.md"), "utf8")
			expect(body).toContain(JSON.stringify(stripFrontmatter(skill).trim()).slice(1, -1))
			expect(body).toContain("Turn meeting notes into action items")
		},
	)
})
