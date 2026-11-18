import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, Shell, test } from "@microsoft/tui-test"
import { fullText, STARTUP_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import {
	createKimchiFixture,
	launchKimchi,
	PROMPT_READY,
	runKimchiSession,
	stopKimchi,
	TUI_TEST_CONFIG,
} from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Unquoted prose with ": " inside is not strict YAML, but loads.
const LOADS =
	"---\ndescription: Tidies imports. <example>Context: a file was edited.</example>\n---\n\nYou tidy imports.\n"
// An unclosed list cannot be repaired: skipped, then reported to the user.
const BROKEN = "---\ndescription: broken\ntools: [read, bash\n---\n\nPrompt.\n"

function seedAgents(workDir: string, files: Record<string, string>): void {
	const agentsDir = join(workDir, ".kimchi", "agents")
	mkdirSync(agentsDir, { recursive: true })
	for (const [name, content] of Object.entries(files)) writeFileSync(join(agentsDir, name), content)
}

test("an unparseable agent file collapses to one line that expands via ctrl+o", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-invalid-frontmatter",
			providerId: "kimchi-dev/openai",
			models: [{ slug: "ci-model", displayName: "CI model", provider: "openai" }],
			initialModel: "ci-model",
			responses: [{ stream: ["Still working."] }],
			seedHome(_homeDir, workDir) {
				seedAgents(workDir, { "import-tidier.md": LOADS, "broken-agent.md": BROKEN })
			},
		},
		async (_fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { full: true })

			// Collapsed: one summary line and the shared ctrl+o hint. The file
			// name and the YAML error must not be on screen yet.
			await waitForText(terminal, "[1 agent issue] Some agents were not loaded.", { full: true })
			await waitForText(terminal, "(ctrl+o to expand)", { full: true })
			expect(fullText(terminal)).not.toContain("broken-agent.md")
			trace.step("startup collapsed the skipped agent file into one line")

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "[Agent issues]", { full: true })
			await waitForText(terminal, "broken-agent.md", { full: true })
			await waitForText(terminal, "(ctrl+o to collapse)", { full: true })
			await waitForText(terminal, "Fix the YAML frontmatter to load them.", { full: true })
			trace.step("ctrl+o expanded the per-file detail")

			terminal.submit("Say hello")
			await waitForText(terminal, "Still working.")
			trace.step("session answers a prompt")
		},
	)
})

// Regression guard for the ctrl+o crash class: pi-tui throws
// "Rendered line N exceeds terminal width" during paint when a custom entry
// renders wider than the terminal, and the process dies.
test.describe("narrow terminal", () => {
	test.use({ shell: Shell.Bash, rows: 40, columns: 60 })

	test("expanding a long skipped-file detail does not crash the session", async ({ terminal }) => {
		const longName = "an-agent-file-with-an-extraordinarily-long-name-for-a-narrow-terminal.md"
		await runKimchiSession(
			terminal,
			{
				artifactName: "agent-invalid-frontmatter-narrow",
				providerId: "kimchi-dev/openai",
				models: [{ slug: "ci-model", displayName: "CI model", provider: "openai" }],
				initialModel: "ci-model",
				responses: [{ stream: ["SESSION-ALIVE-AFTER-EXPAND"] }],
				seedHome(_homeDir, workDir) {
					seedAgents(workDir, { [longName]: BROKEN })
				},
			},
			async (_fixture, trace) => {
				await waitForText(terminal, PROMPT_READY, { full: true })
				await waitForText(terminal, "[1 agent issue]", { full: true })

				terminal.keyPress("o", { ctrl: true })
				await waitForText(terminal, "[Agent issues]", { full: true })
				expect(fullText(terminal)).not.toContain("exceeds terminal width")
				trace.step("expanded on a 60-column terminal without overflowing")

				terminal.submit("ping")
				await waitForText(terminal, "SESSION-ALIVE-AFTER-EXPAND", { full: true })
				trace.step("session stayed responsive after the expansion")
			},
		)
	})
})

// A resumed session re-renders every saved custom entry. Notices written by an
// earlier start must stay hidden, or each resume stacks another one at the
// bottom of the history.
test("resuming a session shows one notice, not one per start", async ({ terminal }) => {
	const exitMarker = "__KIMCHI_FRONTMATTER_FIRST_EXIT__"
	const fixture = await createKimchiFixture({
		responses: [{ stream: ["Done."] }],
		seedHome(_homeDir, workDir) {
			seedAgents(workDir, { "broken-agent.md": BROKEN })
		},
	})

	try {
		launchKimchi(terminal, fixture, [], {}, { exitMarker })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS })
		await waitForText(terminal, "[1 agent issue]", { timeoutMs: STARTUP_TIMEOUT_MS })

		// A turn guarantees the session is on disk for `-c`.
		terminal.submit("hello")
		await waitForText(terminal, "Done.", { timeoutMs: STARTUP_TIMEOUT_MS })

		terminal.submit("/quit")
		await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		// The exit marker resets the terminal, so this buffer holds only the
		// resumed session: a replayed notice from the first start would show up
		// as a second occurrence.
		launchKimchi(terminal, fixture, ["-c"])
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: true })
		await waitForText(terminal, "[1 agent issue]", { timeoutMs: STARTUP_TIMEOUT_MS, full: true })

		expect(fullText(terminal).split("[1 agent issue]").length - 1).toBe(1)
	} finally {
		try {
			await stopKimchi(terminal)
		} catch {
			/* best-effort */
		}
		try {
			await fixture.stop()
		} catch {
			/* best-effort */
		}
	}
})
