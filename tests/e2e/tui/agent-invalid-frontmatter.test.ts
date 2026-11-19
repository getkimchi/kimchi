import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, Shell, test } from "@microsoft/tui-test"
import { fullText, STARTUP_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { launchKimchi, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Unquoted prose with ": " inside is not strict YAML, but loads.
const LOADS =
	"---\ndescription: Tidies imports. <example>Context: a file was edited.</example>\n---\n\nYou tidy imports.\n"
// An unclosed list cannot be repaired: skipped, then reported to the user.
const BROKEN = "---\ndescription: broken\ntools: [read, bash\n---\n\nPrompt.\n"
// The collapsed and expanded header share this sentence, so the hint is what
// signals the state change in the e2e assertions below.
const NOTICE = "Warning: Skipped 1 agent file with invalid frontmatter (not loaded)"

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
			await waitForText(terminal, NOTICE, { full: true })
			await waitForText(terminal, "(ctrl+o to expand)", { full: true })
			expect(fullText(terminal)).not.toContain("broken-agent.md")
			// Column 1, flush with pi's own "Warning:" notices.
			expect(fullText(terminal)).toMatch(/^ Warning: Skipped 1 agent file/m)
			trace.step("startup collapsed the skipped agent file into one line")

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "(ctrl+o to collapse)", { full: true })
			await waitForText(terminal, "broken-agent.md", { full: true })
			await waitForText(terminal, "Fix the YAML frontmatter to load them.", { full: true })
			trace.step("ctrl+o expanded the per-file detail")

			terminal.submit("Say hello")
			await waitForText(terminal, "Still working.")
			trace.step("session answers a prompt")
		},
	)
})

// Mouse events exist only in fullscreen mode (the binary default; the fixture
// seeds "regular"), so this test pins it and reads the viewport, not scrollback.
test("a click toggles only the skipped-files notice in fullscreen mode", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-invalid-frontmatter-click",
			providerId: "kimchi-dev/openai",
			models: [{ slug: "ci-model", displayName: "CI model", provider: "openai" }],
			initialModel: "ci-model",
			responses: [{ stream: ["Still working."] }],
			sessionTuiMode: "fullscreen",
			seedHome(_homeDir, workDir) {
				seedAgents(workDir, { "broken-agent.md": BROKEN })
			},
		},
		async (_fixture, trace) => {
			const clickNotice = () => {
				const lines = viewText(terminal).split("\n")
				const row = lines.findIndex((line) => line.includes("Warning: Skipped 1 agent file"))
				expect(row).toBeGreaterThanOrEqual(0)
				terminal.mousePress(lines[row].indexOf("Warning"), row)
			}

			await waitForText(terminal, NOTICE, { full: false })
			await waitForText(terminal, "(ctrl+o to expand)", { full: false })
			expect(viewText(terminal)).not.toContain("broken-agent.md")

			clickNotice()
			await waitForText(terminal, "(ctrl+o to collapse)", { full: false })
			await waitForText(terminal, "broken-agent.md", { full: false })
			await waitForText(terminal, "Fix the YAML frontmatter to load them.", { full: false })
			trace.step("a click expanded the notice")

			// Click and ctrl+o drive one state: the key closes what the click
			// opened, and the click closes what the key opened.
			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, (text) => !text.includes("broken-agent.md"), { full: false })
			await waitForText(terminal, "(ctrl+o to expand)", { full: false })
			trace.step("ctrl+o collapsed the clicked-open notice")

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "broken-agent.md", { full: false })
			clickNotice()
			await waitForText(terminal, (text) => !text.includes("broken-agent.md"), { full: false })
			await waitForText(terminal, "(ctrl+o to expand)", { full: false })
			trace.step("a click collapsed the notice ctrl+o had opened")

			terminal.submit("Say hello")
			await waitForText(terminal, "Still working.", { full: false })
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
				// At 60 columns the sentence truncates by design — the hint keeps its
				// width — so only the stable prefix is asserted here.
				await waitForText(terminal, "Warning: Skipped 1 agent file", { full: true })
				await waitForText(terminal, "(ctrl+o to expand)", { full: true })

				terminal.keyPress("o", { ctrl: true })
				await waitForText(terminal, "(ctrl+o to collapse)", { full: true })
				expect(fullText(terminal)).not.toContain("exceeds terminal width")

				// The row wraps rather than being cut, and the continuation keeps an
				// indent: the failure this guards left the tail unrendered and started
				// the row with an empty line at column 0.
				await waitForText(terminal, "narrow-terminal.md", { full: true })
				expect(fullText(terminal)).not.toContain("\n.kimchi/agents/")
				trace.step("expanded on a 60-column terminal, wrapped with an indent")

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
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-invalid-frontmatter-resume",
			providerId: "kimchi-dev/openai",
			models: [{ slug: "ci-model", displayName: "CI model", provider: "openai" }],
			initialModel: "ci-model",
			responses: [{ stream: ["Done."] }, { stream: ["Still alive."] }],
			exitMarker,
			seedHome(_homeDir, workDir) {
				seedAgents(workDir, { "broken-agent.md": BROKEN })
			},
		},
		async (fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS })
			await waitForText(terminal, NOTICE, { timeoutMs: STARTUP_TIMEOUT_MS })

			// A turn guarantees the session is on disk for the resume leg.
			terminal.submit("hello")
			await waitForText(terminal, "Done.", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("first session reported the skipped file and completed a turn")

			terminal.submit("/quit")
			await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

			launchKimchi(terminal, fixture, ["--continue"])
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: true })
			await waitForText(terminal, NOTICE, { timeoutMs: STARTUP_TIMEOUT_MS, full: true })
			trace.step("resumed session shows a notice")

			// The exit marker reset the terminal, so this buffer holds only the
			// resumed session: a replayed notice from the first start would show
			// up as a second occurrence.
			expect(fullText(terminal).split("Skipped 1 agent file with invalid frontmatter").length - 1).toBe(1)

			terminal.submit("still there?")
			await waitForText(terminal, "Still alive.", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("resumed session still answers")
		},
	)
})
