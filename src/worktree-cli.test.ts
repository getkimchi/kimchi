import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	ensurePreMainWorktree,
	KIMCHI_WORKTREE_ENV,
	KIMCHI_WORKTREE_MAIN_ENV,
	maybePrintWorktreeIncludeHint,
} from "./worktree-cli.js"

/** Run git synchronously in `cwd`; returns trimmed stdout. */
function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
		.toString()
		.trim()
}

async function initRepo(): Promise<string> {
	const raw = await mkdtemp(join(tmpdir(), "wtcli-test-"))
	const root = await realpath(raw)
	git(root, ["init", "-q"])
	git(root, ["config", "user.email", "wt@test"])
	git(root, ["config", "user.name", "Worktree CLI Test"])
	await writeFile(join(root, "README.md"), "# test\n")
	git(root, ["add", "README.md"])
	git(root, ["commit", "-q", "-m", "init"])
	return root
}

describe("ensurePreMainWorktree", () => {
	let main: string
	const originalCwd = process.cwd()
	const savedEnv = { ...process.env }

	beforeEach(async () => {
		main = await initRepo()
	})
	afterEach(async () => {
		process.chdir(originalCwd)
		for (const key of [KIMCHI_WORKTREE_ENV, KIMCHI_WORKTREE_MAIN_ENV]) {
			if (savedEnv[key] === undefined) delete process.env[key]
			else process.env[key] = savedEnv[key]
		}
		// Clean up any worktree created by the test.
		try {
			const list = git(main, ["worktree", "list"])
			const lines = list.split("\n").filter((l) => l.includes(".kimchi/worktrees/"))
			for (const line of lines) {
				const dir = line.trim().split(/\s+/)[0]
				if (dir) git(main, ["worktree", "remove", "--force", dir])
			}
		} catch {
			// repo already gone
		}
		await rm(main, { recursive: true, force: true })
	})

	it("creates, chdirs and exports env for a named worktree", async () => {
		const wt = await ensurePreMainWorktree({
			cwd: main,
			requestedName: "feature-x",
			agentDir: join(main, ".agent"),
			trustOverride: undefined,
		})
		expect(wt.name).toBe("feature-x")
		expect(wt.branch).toBe("worktree-feature-x")
		expect(wt.path).toBe(join(main, ".kimchi", "worktrees", "feature-x"))
		expect(process.cwd()).toBe(wt.path)
		expect(process.env[KIMCHI_WORKTREE_ENV]).toBe(wt.path)
		expect(process.env[KIMCHI_WORKTREE_MAIN_ENV]).toBe(main)
		expect(git(wt.path, ["symbolic-ref", "--short", "HEAD"])).toBe("worktree-feature-x")
	})

	it("generates a name when none is requested", async () => {
		const wt = await ensurePreMainWorktree({ cwd: main, agentDir: join(main, ".agent"), trustOverride: undefined })
		expect(wt.name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/)
		expect(process.cwd()).toBe(wt.path)
	})

	it("reuses an existing worktree (same path, no new one)", async () => {
		const first = await ensurePreMainWorktree({
			cwd: main,
			requestedName: "reuse",
			agentDir: join(main, ".agent"),
			trustOverride: undefined,
		})
		const second = await ensurePreMainWorktree({
			cwd: main,
			requestedName: "reuse",
			agentDir: join(main, ".agent"),
			trustOverride: undefined,
		})
		expect(second.path).toBe(first.path)
		expect(second.reused).toBe(true)
		const rows = git(main, ["worktree", "list", "--porcelain"])
			.split(/\n\n/)
			.filter((r) => r.includes("worktree "))
		expect(rows.length).toBe(2) // main + the one worktree
	})

	it("refuses nested worktree launches", async () => {
		const wt = await ensurePreMainWorktree({
			cwd: main,
			requestedName: "inner",
			agentDir: join(main, ".agent"),
			trustOverride: undefined,
		})
		await expect(
			ensurePreMainWorktree({
				cwd: wt.path,
				requestedName: "nested",
				agentDir: join(main, ".agent"),
				trustOverride: undefined,
			}),
		).rejects.toThrow(/nested worktrees are not supported/)
	})

	it(".worktreeinclude hint prints only on fresh creation without the include file", async () => {
		const wt = await ensurePreMainWorktree({
			cwd: main,
			requestedName: "hint",
			agentDir: join(main, ".agent"),
			trustOverride: undefined,
		})
		const errors: string[] = []
		const originalError = console.error
		console.error = (msg: string) => {
			errors.push(msg)
		}
		try {
			maybePrintWorktreeIncludeHint(main, wt)
			expect(errors.length).toBe(1)
			expect(errors[0]).toContain(".worktreeinclude")
			// Already-printed worktree does not print again.
			const again = await ensurePreMainWorktree({
				cwd: main,
				requestedName: "hint",
				agentDir: join(main, ".agent"),
				trustOverride: undefined,
			})
			maybePrintWorktreeIncludeHint(main, again)
			expect(errors.length).toBe(1)
		} finally {
			console.error = originalError
		}
	})

	it("seeds trust for the worktree path when the main checkout is trusted", async () => {
		const agentDir = join(main, "harness")
		await mkdir(agentDir, { recursive: true })
		// Seed a positive decision for the main checkout first (as a trusted
		// interactive session would), then the worktree must inherit it.
		;new (await import("@earendil-works/pi-coding-agent")).ProjectTrustStore(agentDir).set(main, true)

		const wt = await ensurePreMainWorktree({ cwd: main, requestedName: "trusted", agentDir, trustOverride: undefined })
		const store = new (await import("@earendil-works/pi-coding-agent")).ProjectTrustStore(agentDir)
		expect(store.get(wt.path)).toBe(true)
	})

	it("does not seed trust when the main checkout is untrusted (override)", async () => {
		const agentDir = join(main, "harness")
		await mkdir(agentDir, { recursive: true })

		// A bare repo has no trust-requiring project resources, so headless
		// resolution is trivially trusted; the deterministic untrusted path is
		// the --no-approve override (mirrors cli.ts's cliTrustOverride).
		const wt = await ensurePreMainWorktree({ cwd: main, requestedName: "untrusted", agentDir, trustOverride: false })
		const store = new (await import("@earendil-works/pi-coding-agent")).ProjectTrustStore(agentDir)
		// Only positive decisions are copied; an explicit untrusted decision for
		// the worktree path is not written by this hook.
		expect(store.get(wt.path)).not.toBe(true)
	})
})
