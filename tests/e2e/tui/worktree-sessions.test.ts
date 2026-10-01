import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { DEFAULT_MODEL } from "./support/fake-openai-server.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

function seedRepo(_home: string, workDir: string): void {
	writeFileSync(join(workDir, "README.md"), "committed baseline\n")
	execFileSync("git", ["add", "README.md"], { cwd: workDir })
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], {
		cwd: workDir,
	})
	writeFileSync(join(workDir, "README.md"), "original uncommitted work\n")
}

test("launch flag keeps agent writes and session storage in a separate worktree", async ({ terminal }) => {
	let treesDir: string | undefined
	try {
		await runKimchiSession(
			terminal,
			{
				artifactName: "worktree-launch",
				models: [{ ...DEFAULT_MODEL, contextWindow: 200_000 }],
				gitInit: true,
				seedHome: seedRepo,
				extraArgs: ["--worktree", "fix/isolated"],
				responses: [
					{
						toolCalls: [
							{
								id: "write_isolated",
								function: {
									name: "write",
									arguments: JSON.stringify({ path: "result.txt", content: "isolated change\n" }),
								},
							},
						],
					},
					{ stream: ["Isolated work complete."] },
				],
			},
			async (fixture, trace) => {
				treesDir = `${fixture.workDir}.worktrees`
				const target = join(treesDir, "fix/isolated")
				terminal.submit("Write the isolation marker.")
				await waitForText(terminal, "Isolated work complete.", { timeoutMs: STREAM_TIMEOUT_MS })
				expect(readFileSync(join(target, "result.txt"), "utf8")).toBe("isolated change\n")
				expect(existsSync(join(fixture.workDir, "result.txt"))).toBe(false)
				expect(readFileSync(join(fixture.workDir, "README.md"), "utf8")).toBe("original uncommitted work\n")
				expect(readFileSync(join(target, "README.md"), "utf8")).toBe("committed baseline\n")
				const sessionsDir = join(fixture.agentDir, "sessions")
				const headers = readdirSync(sessionsDir, { recursive: true })
					.filter((path) => typeof path === "string" && path.endsWith(".jsonl"))
					.map((path) => JSON.parse(readFileSync(join(sessionsDir, String(path)), "utf8").split("\n")[0]))
				expect(headers.some((header) => header.cwd === realpathSync(target))).toBe(true)
				const requests = JSON.stringify(fixture.fake.requests)
				expect(requests).toContain("Git branch: fix/isolated")
				trace.step("write, Git context, and persisted session belong to target; source dirty file preserved")
			},
		)
	} finally {
		if (treesDir) rmSync(treesDir, { recursive: true, force: true })
	}
})

test("worktree command starts a child session and returns to the original session", async ({ terminal }) => {
	let treesDir: string | undefined
	try {
		await runKimchiSession(
			terminal,
			{
				artifactName: "worktree-command",
				models: [{ ...DEFAULT_MODEL, contextWindow: 200_000 }],
				gitInit: true,
				seedHome: seedRepo,
				responses: [{ stream: ["Child session ready."] }, { stream: ["Original session restored."] }],
			},
			async (fixture, trace) => {
				treesDir = `${fixture.workDir}.worktrees`
				terminal.submit("/worktree fix/menu")
				await waitForText(terminal, "Start a new session")
				trace.step("worktree created; launch choices visible")
				terminal.write("\r")
				await waitForText(terminal, PROMPT_READY, { full: false, timeoutMs: STARTUP_TIMEOUT_MS })
				terminal.submit("Identify the child session.")
				await waitForText(terminal, "Child session ready.", { timeoutMs: STREAM_TIMEOUT_MS })
				terminal.submit("/session")
				await waitForText(terminal, /fix\/menu/, { full: false })
				trace.step("child session running in worktree")
				terminal.submit("/quit")
				await waitForText(terminal, "Returned to", { full: false, timeoutMs: STARTUP_TIMEOUT_MS })
				terminal.submit("Confirm the original session still works.")
				await waitForText(terminal, "Original session restored.", { timeoutMs: STREAM_TIMEOUT_MS })
				expect(readFileSync(join(fixture.workDir, "README.md"), "utf8")).toBe("original uncommitted work\n")
				trace.step("child exited; original session accepts another turn")
			},
		)
	} finally {
		if (treesDir) rmSync(treesDir, { recursive: true, force: true })
	}
})
