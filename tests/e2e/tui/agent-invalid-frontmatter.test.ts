import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("starts with an unparseable agent file, warns about it, and stays usable", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-invalid-frontmatter",
			providerId: "kimchi-dev/openai",
			models: [{ slug: "ci-model", displayName: "CI model", provider: "openai" }],
			initialModel: "ci-model",
			responses: [{ stream: ["Still working."] }],
			seedHome(_homeDir, workDir) {
				const agentsDir = join(workDir, ".kimchi", "agents")
				mkdirSync(agentsDir, { recursive: true })
				// Unquoted prose with ": " inside is not strict YAML, but loads.
				writeFileSync(
					join(agentsDir, "import-tidier.md"),
					"---\ndescription: Tidies imports. <example>Context: a file was edited.</example>\n---\n\nYou tidy imports.\n",
				)
				// An unclosed list cannot be repaired: skipped with a warning.
				writeFileSync(
					join(agentsDir, "broken-agent.md"),
					"---\ndescription: broken\ntools: [read, bash\n---\n\nPrompt.\n",
				)
			},
		},
		async (_fixture, trace) => {
			await expect(terminal.getByText("Skipped 1 agent file with invalid frontmatter")).toBeVisible()
			await expect(terminal.getByText("broken-agent.md")).toBeVisible()
			trace.step("harness started and named the skipped agent file")
			terminal.submit("Say hello")
			await waitForText(terminal, "Still working.")
			trace.step("session answers a prompt")
		},
	)
})
