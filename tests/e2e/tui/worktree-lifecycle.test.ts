import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import {
	createKimchiFixture,
	launchKimchi,
	PROMPT_READY,
	stopKimchi,
	TUI_TEST_CONFIG,
} from "./support/kimchi-fixture.js"

test.use({ ...TUI_TEST_CONFIG, rows: 50 })

/** Make the fixture's workDir a repo with a commit — `git worktree add`
 *  requires at least one commit in the main checkout. */
function commitSeed(workDir: string): void {
	execFileSync("git", ["init", "-q"], { cwd: workDir })
	execFileSync("git", ["config", "user.email", "[REDACTED-EMAIL_ADDRESS]"], { cwd: workDir })
	execFileSync("git", ["config", "user.name", "Kimchi E2E"], { cwd: workDir })
	writeFileSync(join(workDir, "README.md"), "# worktree e2e\n", "utf-8")
	execFileSync("git", ["add", "README.md"], { cwd: workDir })
	execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: workDir })
}

const worktreeDir = (workDir: string, name: string): string => join(workDir, ".kimchi", "worktrees", name)

/** Env injected into every launch: the exit prompt needs a deterministic
 *  no-UI path in e2e (clack prompts cannot be answered through the pty). */
const EXIT_PROMPT_OFF = { KIMCHI_WORKTREE_NO_PROMPT: "1" }

test("--worktree <name> creates the worktree, runs in it, and keeps it on exit", async ({ terminal }) => {
	const exitMarker = "__KIMCHI_WORKTREE_EXITED__"
	const fixture = await createKimchiFixture({
		responses: [{ stream: ["Working", " in", " the", " worktree."] }],
	})
	commitSeed(fixture.workDir)

	const name = "feature-worktree"
	const dir = worktreeDir(fixture.workDir, name)

	try {
		launchKimchi(terminal, fixture, ["--worktree", name], EXIT_PROMPT_OFF, { exitMarker })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		// The session starts inside the fresh worktree on branch worktree-<name>.
		expect(existsSync(dir)).toBe(true)
		expect(execFileSync("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"]).toString().trim()).toBe(
			`worktree-${name}`,
		)
		const sessionCwd = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"]).toString().trim()
		// git prints the realpath (/private/var/... when /var is a symlink).
		expect(sessionCwd).toBe(realpathSync(dir))

		terminal.submit("hi")
		await waitForText(terminal, "Working in the worktree.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })

		terminal.submit("/quit")
		await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		// Non-interactive exit path keeps the (clean, named) worktree.
		expect(existsSync(dir)).toBe(true)
	} finally {
		stopKimchi(terminal)
	}
})

test("--worktree with no name auto-generates the worktree on a generated branch", async ({ terminal }) => {
	const fixture = await createKimchiFixture({
		responses: [{ stream: ["ok"] }],
	})
	commitSeed(fixture.workDir)

	try {
		launchKimchi(terminal, fixture, ["--worktree"], EXIT_PROMPT_OFF, {})
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		// The unnamed worktree is created under .kimchi/worktrees with a
		// generated adjective-noun-hex name and matching branch.
		const entries = execFileSync("git", ["-C", fixture.workDir, "worktree", "list", "--porcelain"])
			.toString()
			.split("\n\n")
			.filter((entry) => entry.includes(".kimchi/worktrees/"))
		expect(entries).toHaveLength(1)
		const dir = entries[0].split("\n")[0].replace(/^worktree /, "")
		expect(dir).toMatch(/[a-z]+-[a-z]+-[0-9a-f]{4}$/)
		const branch = execFileSync("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"]).toString().trim()
		expect(branch).toMatch(/^worktree-[a-z]+-[a-z]+-[0-9a-f]{4}$/)
	} finally {
		stopKimchi(terminal)
	}
})

test("--worktree reuses an existing worktree of the same name", async ({ terminal }) => {
	const fixture = await createKimchiFixture({
		responses: [{ stream: ["again"] }],
	})
	commitSeed(fixture.workDir)
	const name = "reuse-me"
	mkdirSync(join(fixture.workDir, ".kimchi", "worktrees"), { recursive: true })
	execFileSync(
		"git",
		["-C", fixture.workDir, "worktree", "add", "-b", `worktree-${name}`, worktreeDir(fixture.workDir, name), "HEAD"],
		{ stdio: "ignore" },
	)

	try {
		launchKimchi(terminal, fixture, ["--worktree", name], EXIT_PROMPT_OFF, {})
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		// Reused — still exactly one linked worktree under .kimchi/worktrees.
		const entries = execFileSync("git", ["-C", fixture.workDir, "worktree", "list", "--porcelain"])
			.toString()
			.split("\n\n")
			.filter((entry) => entry.includes(".kimchi/worktrees/"))
		expect(entries).toHaveLength(1)
	} finally {
		stopKimchi(terminal)
	}
})
