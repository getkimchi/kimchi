import { randomUUID } from "node:crypto"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { DEFAULT_MODEL } from "./support/fake-openai-server.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

function seedSessions(homeDir: string, workDir: string): void {
	const cwd = realpathSync(workDir)
	const other = join(cwd, "other-project")
	mkdirSync(other)
	for (const [directory, name, prompt, answer, timestamp] of [
		[cwd, "Documentation notes", "Explain the readme", "OLD_DOCUMENTATION", "2026-01-01T08:00:00.000Z"],
		[
			cwd,
			"Fix pool timeouts",
			"Investigate connection latency",
			"SAVED_POOL_RESPONSE saffron retry is ready",
			"2026-02-02T12:30:00.000Z",
		],
		[other, "Other project work", "Review cross-project-marker", "SAVED_OTHER_RESPONSE", "2026-03-03T10:00:00.000Z"],
	]) {
		const dir = join(
			homeDir,
			".config/kimchi/harness/sessions",
			`--${directory.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
		)
		mkdirSync(dir, { recursive: true })
		const id = randomUUID()
		const entries = [
			{ type: "session", version: 3, id, timestamp, cwd: directory },
			{ type: "session_info", id: "name", parentId: null, timestamp, name },
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
			expect(initial).toContain("Current folder · Last active")
			expect(initial.indexOf("Fix pool timeouts")).toBeLessThan(initial.indexOf("Documentation notes"))
			expect(initial).toContain("Last active:")
			expect(initial).toContain("Created:")
			expect(initial).toContain("2 messages")
			expect(initial).not.toContain("Other project work")
			trace.step("recent sessions and selected metadata visible")
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
			terminal.write("cross-project-marker")
			await waitForText(terminal, "No matching sessions", { full: false })
			trace.step("current folder has no matching session")
			terminal.write("\t")
			await waitForText(terminal, "1/1 sessions", { full: false })
			expect(viewText(terminal)).toContain("All folders · Best match")
			expect(viewText(terminal)).toContain("other-project")
			expect(viewText(terminal)).toContain("Other project work")
			trace.step("all folders retains the query and shows the target directory")
			terminal.submit("")
			await waitForText(terminal, PROMPT_READY, { full: false })
			expect(viewText(terminal)).toContain("SAVED_OTHER_RESPONSE")
			trace.step("CLI resumes the selected conversation")
		},
	)
})
