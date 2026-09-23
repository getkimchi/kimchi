import { randomUUID } from "node:crypto"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { DEFAULT_MODEL } from "./support/fake-openai-server.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

function seedSessions(homeDir: string, workDir: string, archivedCount = 0): void {
	const cwd = realpathSync(workDir)
	const other = join(cwd, "other-project")
	mkdirSync(other)
	let parentSession = ""
	for (const [directory, name, prompt, answer, timestamp] of [
		[
			cwd,
			"Documentation notes",
			"Explain the readme and its setup instructions. ".repeat(12),
			"OLD_DOCUMENTATION",
			"2026-01-01T08:00:00.000Z",
		],
		[
			cwd,
			"Fix pool timeouts",
			"Investigate connection latency",
			"SAVED_POOL_RESPONSE saffron retry is ready",
			"2026-02-02T12:30:00.000Z",
		],
		[other, "Other project work", "Review cross-project-marker", "SAVED_OTHER_RESPONSE", "2026-03-03T10:00:00.000Z"],
		[cwd, "Internal evaluator fixture", "Evaluate the saved task", "INTERNAL_RESPONSE", "2026-04-01T10:00:00.000Z"],
		...Array.from({ length: archivedCount }, (_, index) => [
			cwd,
			`Archived session ${index}`,
			"Investigate a long-running request and preserve its context. ".repeat(8),
			"ARCHIVED_RESPONSE",
			new Date(Date.UTC(2025, 0, 20 - index)).toISOString(),
		]),
	]) {
		const dir = join(
			homeDir,
			".config/kimchi/harness/sessions",
			`--${directory.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
		)
		mkdirSync(dir, { recursive: true })
		const id = randomUUID()
		const internal = name === "Internal evaluator fixture"
		if (name === "Fix pool timeouts") parentSession = join(dir, `${id}.jsonl`)
		const entries = [
			{
				type: "session",
				version: 3,
				id,
				timestamp,
				cwd: directory,
				...(internal ? { parentSession } : {}),
			},
			...(internal
				? [
						{
							type: "custom",
							id: "internal",
							parentId: null,
							timestamp,
							customType: "kimchi:internal-session",
							data: { kind: "ferment-evaluator" },
						},
					]
				: []),
			{ type: "session_info", id: "name", parentId: null, timestamp, name },
			{ type: "model_change", id: "model", parentId: "name", timestamp, provider: "fake", modelId: "basic" },
			{
				type: "message",
				id: "user",
				parentId: "name",
				timestamp,
				message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.parse(timestamp) },
			},
			{
				type: "message",
				id: "assistant",
				parentId: "user",
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: answer }],
					api: "openai-completions",
					provider: "fake",
					model: DEFAULT_MODEL.slug,
					usage: {
						input: 10,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 20,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.parse(timestamp),
				},
			},
		]
		writeFileSync(join(dir, `${id}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
	}
}

test("find a session by conversation text, inspect its dates, and continue it", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "resume-explorer-search",
			seedHome: seedSessions,
			responses: [{ stream: ["POOL_CONTINUED_OK"] }],
		},
		async (fixture, trace) => {
			terminal.write("/resume")
			await waitForText(terminal, "/resume", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, "First message:", { full: false })
			const initial = viewText(terminal)
			expect(initial).toContain("Current folder · Threads")
			expect(initial.indexOf("Fix pool timeouts")).toBeLessThan(initial.indexOf("Documentation notes"))
			expect(initial).toContain("Last active:")
			expect(initial).toContain("Created:")
			expect(initial).toContain("2 messages")
			expect(initial).not.toContain("Other project work")
			expect(initial).toContain("└─ [evaluator] Internal evaluator fixture")
			expect(initial).toContain("ctrl+e evaluators (on)")
			trace.step("parent/child tree and selected metadata visible by default")
			terminal.write("\x06")
			await waitForText(terminal, "File:", { full: false })
			expect(viewText(terminal)).toContain("ctrl+f file (on)")
			terminal.write("\x06")
			await waitForText(terminal, "ctrl+f file (off)", { full: false })
			expect(viewText(terminal)).not.toContain("File:")
			trace.step("file shortcut works inside the running harness")
			const position = (label: string) =>
				viewText(terminal)
					.split("\n")
					.findIndex((line) => line.includes(label))
			const headingRow = position("Resume session")
			const actionsRow = position("enter resume")
			terminal.keyDown()
			await waitForText(terminal, "2/3 sessions", { full: false })
			expect(viewText(terminal)).toContain("Role:          Checks whether the parent task is complete")
			expect(position("Resume session")).toBe(headingRow)
			expect(position("enter resume")).toBe(actionsRow)
			terminal.keyDown()
			await waitForText(terminal, "3/3 sessions", { full: false })
			expect(position("Resume session")).toBe(headingRow)
			expect(position("enter resume")).toBe(actionsRow)
			terminal.keyUp()
			await waitForText(terminal, "2/3 sessions", { full: false })
			terminal.keyUp()
			await waitForText(terminal, "1/3 sessions", { full: false })
			expect(position("Resume session")).toBe(headingRow)
			expect(position("enter resume")).toBe(actionsRow)
			trace.step("normal and evaluator details keep the menu in place on Down and Up")
			terminal.write('"saffron retry"')
			await waitForText(terminal, "1/1 sessions", { full: false })
			expect(viewText(terminal)).toContain("Conversation:")
			expect(viewText(terminal)).toContain("saffron retry is ready")
			trace.step("exact conversation search reveals matching context")
			terminal.submit("")
			await waitForText(terminal, "Resumed session", { full: false })
			await waitForText(terminal, PROMPT_READY, { full: false })
			terminal.submit("Continue with the pool fix")
			await waitForText(terminal, "POOL_CONTINUED_OK", { full: false })
			expect(JSON.stringify(fixture.fake.requests)).toContain("SAVED_POOL_RESPONSE")
			trace.step("resumed the chosen history and completed a follow-up")
		},
	)
})

test("CLI resume keeps a search while expanding to all folders and resumes the matching project", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "resume-explorer-cli-scope",
			seedHome: seedSessions,
			responses: [],
			extraArgs: ["--resume"],
			startupText: "First message:",
		},
		async (_fixture, trace) => {
			expect(viewText(terminal)).toContain("ctrl+e evaluators (on)")
			const tree = viewText(terminal)
			expect(tree).toContain("Current folder · Threads")
			expect(tree).toContain("└─ [evaluator] Internal evaluator fixture")
			expect(tree.indexOf("Fix pool timeouts")).toBeLessThan(tree.indexOf("└─ [evaluator]"))
			terminal.keyDown()
			await waitForText(terminal, "Role:          Checks whether the parent task is complete", { full: false })
			expect(viewText(terminal)).toContain("Parent:        Fix pool timeouts")
			expect(viewText(terminal)).toContain("Initial model: fake/basic")
			terminal.write("\x05")
			await waitForText(terminal, "1 evaluator hidden", { full: false })
			expect(viewText(terminal)).not.toContain("Internal evaluator fixture")
			trace.step("CLI shows the marked child by default and Ctrl+E hides it")
			terminal.write("cross-project-marker")
			await waitForText(terminal, "No matching sessions", { full: false })
			trace.step("current folder has no matching session")
			terminal.write("\t")
			await waitForText(terminal, "1/1 sessions", { full: false })
			expect(viewText(terminal)).toContain("All folders · Best match")
			expect(viewText(terminal)).toContain("other-project")
			expect(viewText(terminal)).toContain("Other project work")
			expect(viewText(terminal)).toMatch(/Project\s+Session/)
			trace.step("all folders retains the query and shows the target directory")
			terminal.submit("")
			await waitForText(terminal, PROMPT_READY, { full: false })
			await waitForText(terminal, "SAVED_OTHER_RESPONSE", { full: false })
			trace.step("CLI resumes the selected conversation")
		},
	)
})

test("page and cancel deletion without losing the resume controls in an 80 by 24 terminal", async ({ terminal }) => {
	terminal.resize(80, 24)
	await runKimchiSession(
		terminal,
		{
			artifactName: "resume-explorer-small-terminal",
			seedHome: (home, work) => seedSessions(home, work, 14),
			responses: [],
		},
		async (_fixture, trace) => {
			terminal.write("/resume")
			await waitForText(terminal, "/resume", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, "1/17 sessions", { full: false })
			terminal.write("\x1b[6~")
			await waitForText(terminal, "5/17 sessions", { full: false })
			expect(viewText(terminal)).toContain("Resume session · Current folder")
			expect(viewText(terminal)).toContain("First message:")
			expect(viewText(terminal)).toContain("enter resume")
			trace.step("paging retains the heading, preview and actions above the harness footer")
			terminal.write("\x04")
			await waitForText(terminal, "enter confirm deletion", { full: false })
			expect(viewText(terminal)).not.toContain("enter resume")
			terminal.write("\x1b")
			await waitForText(terminal, "enter resume", { full: false })
			expect(viewText(terminal)).toContain("5/17 sessions")
			trace.step("deletion is labeled accurately and cancellation preserves the selection")
			terminal.write("\x05")
			await waitForText(terminal, "4/16 sessions", { full: false })
			terminal.write("\x05")
			await waitForText(terminal, "5/17 sessions", { full: false })
			trace.step("interactive internal-session toggle keeps navigation working at 80 columns")
		},
	)
})
