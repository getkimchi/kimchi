import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createBackgroundBashToolDefinition } from "../bash-background/bash-background-tool.js"
import bashBackgroundExtension from "../bash-background/index.js"
import { createProcessRegistry } from "../bash-background/process-registry.js"
import { getSessionRegistry, setSessionRegistry } from "../bash-background/session-registry.js"
import * as attribution from "../work-attribution.js"
import { createCommitTrackingBashTool, createCommitTrackingOperations, type ObservedCommit } from "./commits.js"
import * as diagnostics from "./diagnostics.js"
import { flushWorkSummaries } from "./summary.js"

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof fs>()),
}))

let directory: string
let repository: string
let commits: ObservedCommit[]

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`
}

async function run(command: string, cwd = repository): Promise<number | null> {
	return (
		await createCommitTrackingOperations((commit) => commits.push(commit)).exec(command, cwd, {
			onData: () => {},
			env: { ...process.env },
		})
	).exitCode
}

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-commits-test-")))
	repository = join(directory, "repo")
	git(directory, "init", "--initial-branch=main", repository)
	git(repository, "config", "user.name", "Kimchi Test")
	git(repository, "config", "user.email", "test@example.invalid")
	git(repository, "config", "commit.gpgSign", "false")
	commits = []
})

afterEach(async () => {
	await flushWorkSummaries()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	rmSync(directory, { recursive: true, force: true })
})

describe("Git commit observation", () => {
	it("discovers replay paths once per cwd across separate Bash calls", async () => {
		git(repository, "commit", "--allow-empty", "-m", "base")
		const worktree = join(directory, "linked")
		git(repository, "worktree", "add", "-b", "linked", worktree)
		const executable = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
		const bin = join(directory, "bin")
		const lookups = join(directory, "lookups")
		fs.mkdirSync(bin)
		writeFileSync(
			join(bin, "git"),
			`#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(lookups)}\nexec ${quote(executable)} "$@"\n`,
			{ mode: 0o700 },
		)
		vi.stubEnv("PATH", `${bin}:${process.env.PATH}`)

		// Each call creates new tracking operations, as both registered Bash tools do.
		expect(await run("true")).toBe(0)
		expect(await run("true")).toBe(0)
		expect(await run("true", worktree)).toBe(0)
		expect(await run("true", worktree)).toBe(0)
		const discovery = fs.readFileSync(lookups, "utf8").trim().split("\n")
		expect(discovery).toHaveLength(2)
		expect(discovery[0]).toContain("--show-toplevel --git-path REBASE_HEAD --git-path CHERRY_PICK_HEAD")
		expect(discovery[1]).toContain(`-C ${worktree} rev-parse`)
	})

	it("records root commits and amendments even when the shell later fails", async () => {
		expect(await run("git commit --allow-empty -m first && git commit --allow-empty --amend -m amended; false")).toBe(1)
		const shas = git(repository, "reflog", "--format=%H").split("\n").reverse()
		expect(commits).toEqual(shas.map((sha) => ({ sha, repository: join(repository, ".git"), worktree: repository })))
	})

	it.each([
		"GIT_TRACE2_EVENT",
		"GIT_TRACE_REFS",
	])("records commits before and after %s exceeds 8 MiB", async (variable) => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		const sizePath = join(directory, "trace-size")
		const pad = `const fs = require("node:fs");
const line = ${variable === "GIT_TRACE2_EVENT" ? 'JSON.stringify({ event: "data", detail: "x".repeat(1024) })' : '"12:00:00.000000 refs/debug.c:1: read_raw_ref: " + "x".repeat(1024)'} + "\\n";
fs.appendFileSync(process.env.${variable}, line.repeat(8192));
fs.writeFileSync(${JSON.stringify(sizePath)}, String(fs.statSync(process.env.${variable}).size));`
		expect(
			await run(
				`git commit --allow-empty -m before && ${quote(process.execPath)} -e ${quote(pad)} && git commit --allow-empty -m after; false`,
			),
		).toBe(1)
		expect(Number(fs.readFileSync(sizePath, "utf8"))).toBeGreaterThan(8 * 1024 * 1024)
		expect(commits.map((commit) => commit.sha)).toEqual(git(repository, "reflog", "--format=%H").split("\n").reverse())
		expect(warning).not.toHaveBeenCalled()
	})

	it("does not print a failed Git trace over the terminal", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.spyOn(fs, "mkdtempSync").mockImplementation(() => {
			throw new Error("trace storage unavailable")
		})
		expect(await run("true")).toBe(0)
		expect(warning).not.toHaveBeenCalled()
	})

	it.each(["malformed", "unreadable"])("keeps Bash results and cleans up a %s trace", async (failure) => {
		const debug = vi.spyOn(diagnostics, "debugWorkAttribution").mockImplementation(() => {})
		const cleanup = vi.spyOn(fs, "rmSync")
		const damage =
			failure === "malformed"
				? 'printf "bad json\\n" >> "$GIT_TRACE2_EVENT"'
				: 'rm "$GIT_TRACE2_EVENT" && mkdir "$GIT_TRACE2_EVENT"'
		expect(await run(`git commit --allow-empty -m unverified && ${damage}; false`)).toBe(1)
		expect(commits).toEqual([])
		expect(debug).toHaveBeenCalledWith("Could not record Git commits:", expect.any(Error))
		const tracePath = cleanup.mock.calls[0]?.[0]
		expect(tracePath).toBeTruthy()
		if (tracePath) expect(fs.existsSync(tracePath)).toBe(false)
	})

	it("tracks the actual git -C and shell cd worktrees", async () => {
		git(repository, "commit", "--allow-empty", "-m", "base")
		const worktree = join(directory, "linked tree")
		git(repository, "worktree", "add", "-b", "linked", worktree)
		expect(
			await run(
				`git -C ${quote(worktree)} commit --allow-empty -m linked; cd ${quote(repository)} && git commit --allow-empty -m main`,
				directory,
			),
		).toBe(0)
		expect(commits).toEqual([
			{ sha: git(worktree, "rev-parse", "HEAD"), repository: join(repository, ".git"), worktree },
			{ sha: git(repository, "rev-parse", "HEAD"), repository: join(repository, ".git"), worktree: repository },
		])
	})

	it.each([
		"first",
		"middle",
	])("preserves other commits when a removed worktree is %s in the trace", async (position) => {
		git(repository, "commit", "--allow-empty", "-m", "base")
		const worktree = join(directory, "removed tree")
		git(repository, "worktree", "add", "-b", "disposable", worktree)
		const commands = [
			...(position === "middle" ? ["git commit --allow-empty -m before"] : []),
			`git -C ${quote(worktree)} commit --allow-empty -m removed`,
			`git worktree remove ${quote(worktree)}`,
			"git commit --allow-empty -m after",
		]
		const warning = vi.spyOn(diagnostics, "debugWorkAttribution").mockImplementation(() => {})
		expect(await run(commands.join(" && "))).toBe(0)
		const names = position === "middle" ? ["before", "after"] : ["after"]
		expect(commits).toEqual(
			names.map((name) => ({
				sha: git(repository, "reflog", "--format=%H", `--grep-reflog=commit: ${name}`),
				repository: join(repository, ".git"),
				worktree: repository,
			})),
		)
		expect(warning).toHaveBeenCalledWith("Could not resolve Git commit repository:", expect.any(Error))
	})

	it("does not record checkout or reset alongside a real commit", async () => {
		git(repository, "commit", "--allow-empty", "-m", "base")
		await run("git commit --allow-empty -m ours; git reset --hard HEAD~; git checkout -b other")
		const ours = git(repository, "reflog", "--format=%H", "--grep-reflog=commit: ours")
		expect(commits.map((commit) => commit.sha)).toEqual([ours])
	})

	it("does not record pulled or concurrently externally created commits", async () => {
		git(repository, "commit", "--allow-empty", "-m", "base")
		const remote = join(directory, "remote")
		git(directory, "clone", repository, remote)
		git(remote, "config", "user.name", "Other")
		git(remote, "config", "user.email", "other@example.invalid")
		git(remote, "commit", "--allow-empty", "-m", "remote")
		await run(`git pull --ff-only ${quote(remote)} main`)
		expect(commits).toEqual([])
		const operations = createCommitTrackingOperations((commit) => commits.push(commit))
		await operations.exec("echo ready; sleep 0.2", repository, {
			onData: () => git(repository, "commit", "--allow-empty", "-m", "external"),
			env: { ...process.env },
		})
		expect(commits).toEqual([])
	})

	it("preserves Git hooks and records the commit after a successful hook", async () => {
		writeFileSync(join(repository, ".git", "hooks", "pre-commit"), "#!/bin/sh\ngit rev-parse --git-dir >/dev/null\n", {
			mode: 0o700,
		})
		expect(await run("git commit --allow-empty -m hooked")).toBe(0)
		expect(commits.map((commit) => commit.sha)).toEqual([git(repository, "rev-parse", "HEAD")])
	})

	it.each([
		"maintenance run --auto --no-detach",
		"gc --auto --no-detach",
	])("records a commit while Git %s is running", async (maintenance) => {
		// Two packs trigger auto-GC without relying on Git's loose-object sampling.
		for (const message of ["base", "second"]) {
			git(repository, "commit", "--allow-empty", "-qm", message)
			execFileSync("git", ["-C", repository, "pack-objects", join(repository, ".git", "objects", "pack", "pack")], {
				input: `${git(repository, "rev-parse", "HEAD")}\n`,
				stdio: ["pipe", "pipe", "pipe"],
			})
		}
		git(repository, "config", "gc.autoPackLimit", "1")
		const ready = quote(join(directory, "maintenance-ready"))
		const release = quote(join(directory, "maintenance-release"))
		writeFileSync(
			join(repository, ".git", "hooks", "pre-auto-gc"),
			`#!/bin/sh
touch ${ready}
attempt=0
while ! test -f ${release}; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 500 || exit 1
  sleep 0.02
done
`,
			{ mode: 0o700 },
		)
		expect(
			await run(`
git ${maintenance} &
maintenance_pid=$!
finish() { touch ${release}; wait "$maintenance_pid"; }
trap finish EXIT
attempt=0
while ! test -f ${ready}; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 400 || exit 1
  sleep 0.02
done
git -c maintenance.auto=false -c gc.auto=0 commit --allow-empty -qm concurrent
commit_result=$?
touch ${release}
wait "$maintenance_pid" || exit 1
exit "$commit_result"
`),
		).toBe(0)
		expect(commits.map((commit) => commit.sha)).toEqual([git(repository, "rev-parse", "HEAD")])
	})

	it("does not record failed commits or dry runs", async () => {
		git(repository, "commit", "--allow-empty", "-m", "base")
		await run("git commit -m empty; git commit --dry-run --allow-empty -m dry")
		expect(commits).toEqual([])
	})

	it("does not attribute a reset performed by a nested Git process in a commit hook", async () => {
		git(repository, "commit", "--allow-empty", "-m", "base")
		git(repository, "commit", "--allow-empty", "-m", "existing")
		const worktree = join(directory, "hook-worktree")
		git(repository, "worktree", "add", "-b", "hook-target", worktree)
		writeFileSync(
			join(repository, ".git", "hooks", "pre-commit"),
			`#!/bin/sh
unset GIT_INDEX_FILE
git -C ${quote(worktree)} reset --hard HEAD~ >/dev/null
`,
			{ mode: 0o700 },
		)
		expect(await run("git commit --allow-empty -m ours")).toBe(0)
		expect(commits).toEqual([
			{ sha: git(repository, "rev-parse", "HEAD"), repository: join(repository, ".git"), worktree: repository },
		])
	})

	it.each([5, 10])("records commits through the registered background Bash tool (timeout %s)", async (timeout) => {
		const ctx = createContext({ cwd: repository })
		const pi = createExtensionApi()
		vi.spyOn(attribution, "getWorkId").mockReturnValue("original-work")
		const record = vi.spyOn(attribution, "appendWorkRecord").mockImplementation(() => {})
		bashBackgroundExtension(pi.api)
		await pi.getHandler("session_start")({ type: "session_start" }, ctx)
		try {
			await pi
				.getRegisteredTool("bash")
				.execute(
					"registered-commit",
					{ command: "git commit --allow-empty -m registered", timeout },
					undefined,
					undefined,
					ctx,
				)
			expect(record).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					type: "commit",
					sha: git(repository, "rev-parse", "HEAD"),
					toolCallId: "registered-commit",
				}),
				"original-work",
			)
		} finally {
			await getSessionRegistry()?.shutdown()
			setSessionRegistry(undefined)
		}
	})

	it("records a background commit after the first checkin under its original session and work", async () => {
		let sessionId = "original-session"
		const ctx = createContext({ cwd: repository, sessionManager: { getSessionId: vi.fn(() => sessionId) } })
		const work = vi.spyOn(attribution, "getWorkId").mockReturnValue("original-work")
		const record = vi.spyOn(attribution, "appendWorkRecord").mockImplementation(() => {})
		const registry = createProcessRegistry()
		try {
			const result = await createBackgroundBashToolDefinition(repository, { registry }).execute(
				"background-commit",
				{ command: "sleep 0.3; git commit --allow-empty -m delayed", timeout: 10, checkin_interval: 0.01 },
				undefined,
				undefined,
				ctx,
			)
			const handle = result.details?.handle
			expect(handle).toBeTruthy()
			expect(record).not.toHaveBeenCalled()
			if (!handle) throw new Error("Missing background process handle")
			sessionId = "replacement-session"
			work.mockReturnValue("replacement-work")
			await registry.whenExited(handle)
			expect(record).toHaveBeenCalledOnce()
			const [pinned, fields, workId] = record.mock.calls[0]
			expect(pinned.sessionManager.getSessionId()).toBe("original-session")
			expect(workId).toBe("original-work")
			expect(fields).toMatchObject({ sha: git(repository, "rev-parse", "HEAD"), toolCallId: "background-commit" })
		} finally {
			await registry.shutdown()
		}
	})

	it.each(["allocation", "cleanup"])("preserves Bash execution when trace %s fails", async (stage) => {
		const warning = vi.spyOn(diagnostics, "debugWorkAttribution").mockImplementation(() => {})
		const silence = vi.spyOn(console, "warn")
		const failure = new Error("trace storage unavailable")
		const hook =
			stage === "allocation"
				? vi.spyOn(fs, "mkdtempSync").mockImplementation(() => {
						throw failure
					})
				: vi.spyOn(fs, "rmSync").mockImplementation(() => {
						throw failure
					})
		try {
			expect(await run("printf still-running")).toBe(0)
			expect(warning).toHaveBeenCalledWith(
				stage === "allocation" ? "Could not initialize Git trace:" : "Could not remove Git trace:",
				failure,
			)
			expect(silence).not.toHaveBeenCalled()
		} finally {
			const tracePath = hook.mock.calls[0]?.[0]
			hook.mockRestore()
			if (stage === "cleanup" && tracePath) rmSync(tracePath, { recursive: true, force: true })
		}
	})

	it.each(["foreground", "background"])("runs %s Bash when work persistence fails", async (mode) => {
		const ctx = createContext({ cwd: repository })
		vi.spyOn(attribution, "getWorkId").mockImplementation(() => {
			throw new Error("ledger unavailable")
		})
		const warning = vi.spyOn(diagnostics, "debugWorkAttribution").mockImplementation(() => {})
		const registry = createProcessRegistry()
		try {
			const tool =
				mode === "background"
					? createBackgroundBashToolDefinition(repository, { registry })
					: createCommitTrackingBashTool(ctx)
			const result = await tool.execute(
				"without-attribution",
				{ command: "printf bash-still-works" },
				undefined,
				undefined,
				ctx,
			)
			expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: "bash-still-works" })]))
			expect(warning).toHaveBeenCalledWith(
				"Could not initialize Git attribution:",
				expect.objectContaining({ message: "ledger unavailable" }),
			)
		} finally {
			await registry.shutdown()
		}
	})

	// The restart case loads the harness in a fresh Node process as well as running real Git commands.
	it.each([
		false,
		true,
	])("follows this work's commits through rebase and conflict continue (restart: %s)", async (restart) => {
		vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"))
		const ctx = createContext({ cwd: repository, sessionManager: { getSessionId: () => "rebasing" } })
		const tool = createCommitTrackingBashTool(ctx)
		const bash = (command: string) => tool.execute("rebase-tool", { command }, undefined, undefined, ctx)
		writeFileSync(join(repository, "shared.txt"), "base\n")
		git(repository, "add", ".")
		git(repository, "commit", "-qm", "base")
		git(repository, "checkout", "-qb", "other")
		writeFileSync(join(repository, "unrelated.txt"), "someone else\n")
		git(repository, "add", ".")
		git(repository, "commit", "-qm", "unrelated")
		git(repository, "checkout", "-q", "main")
		await bash(
			"git checkout -qb feat && echo ours > ours.txt && git add ours.txt && git commit -qm ours && echo mine > shared.txt && git commit -qam conflicting",
		)
		const [conflicting, ours] = git(repository, "rev-list", "-2", "HEAD").split("\n")
		const upstream = join(directory, "upstream")
		git(repository, "worktree", "add", "-q", upstream, "main")
		writeFileSync(join(upstream, "shared.txt"), "theirs\n")
		git(upstream, "commit", "-qam", "upstream moved")
		git(repository, "worktree", "remove", upstream)

		// The agent sees the conflict, resolves it, and continues in a later call.
		await bash("git rebase main || true")
		const continueCommand = "echo resolved > shared.txt && git add shared.txt && GIT_EDITOR=true git rebase --continue"
		if (restart) {
			await flushWorkSummaries()
			const script = `
import { createWorkCommitTrackingOperations } from ${JSON.stringify(new URL("./commits.ts", import.meta.url).pathname)};
import { flushWorkSummaries } from ${JSON.stringify(new URL("./summary.ts", import.meta.url).pathname)};
const ctx = { cwd: ${JSON.stringify(repository)}, sessionManager: { getSessionId: () => "rebasing" } };
await createWorkCommitTrackingOperations(ctx, "continued").exec(${JSON.stringify(continueCommand)}, ctx.cwd, { onData() {}, env: process.env });
await flushWorkSummaries();`
			execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				env: process.env,
				timeout: 10000,
			})
		} else await bash(continueCommand)
		const [rebasedConflicting, rebasedOurs] = git(repository, "rev-list", "-2", "HEAD").split("\n")
		await bash("git cherry-pick other")

		const recorded = fs
			.readFileSync(join(directory, "agent", "work-attribution", "rebasing.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((row) => row.type === "commit")
			.map(({ sha, rewrittenFrom }) => ({ sha, rewrittenFrom }))
		expect(recorded).toEqual([
			{ sha: ours },
			{ sha: conflicting },
			{ sha: rebasedOurs, rewrittenFrom: ours },
			{ sha: rebasedConflicting, rewrittenFrom: conflicting },
		])
	}, 15000)

	it("records same-work cherry-picks, reverts and new merge commits", async () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"))
		const ctx = createContext({ cwd: repository, sessionManager: { getSessionId: () => "sequencer" } })
		const tool = createCommitTrackingBashTool(ctx)
		const bash = (command: string) => tool.execute("sequencer-tool", { command }, undefined, undefined, ctx)
		git(repository, "commit", "--allow-empty", "-qm", "base")
		await bash("git checkout -qb feature && echo ours > ours.txt && git add ours.txt && git commit -qm ours")
		const original = git(repository, "rev-parse", "HEAD")
		git(repository, "checkout", "-q", "main")
		git(repository, "commit", "--allow-empty", "-qm", "upstream")
		await bash("git cherry-pick feature")
		const picked = git(repository, "rev-parse", "HEAD")
		await bash("git revert --no-edit HEAD")
		const reverted = git(repository, "rev-parse", "HEAD")
		git(repository, "checkout", "-qb", "other")
		writeFileSync(join(repository, "other.txt"), "other")
		git(repository, "add", ".")
		git(repository, "commit", "-qm", "other")
		git(repository, "checkout", "-q", "main")
		await bash("git merge --no-ff --no-edit other")
		const merged = git(repository, "rev-parse", "HEAD")
		const recorded = fs
			.readFileSync(attribution.workLedgerPath(ctx), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((row) => row.type === "commit")
			.map(({ sha, rewrittenFrom }) => ({ sha, rewrittenFrom }))
		expect(recorded).toEqual([
			{ sha: original },
			{ sha: picked, rewrittenFrom: original },
			{ sha: reverted },
			{ sha: merged },
		])
	})

	it("pins the session and work while the tool is running", async () => {
		let sessionId = "original-session"
		let workId = "original-work"
		const ctx = createContext({ cwd: repository, sessionManager: { getSessionId: vi.fn(() => sessionId) } })
		vi.spyOn(attribution, "getWorkId").mockImplementation(() => workId)
		const record = vi.spyOn(attribution, "appendWorkRecord").mockImplementation(() => {})
		await createCommitTrackingBashTool(ctx).execute(
			"commit-tool",
			{
				command: "echo ready; sleep 0.3; git commit --allow-empty -m pinned",
			},
			undefined,
			() => {
				sessionId = "replacement-session"
				workId = "replacement-work"
			},
			ctx,
		)
		expect(sessionId).toBe("replacement-session")
		expect(record).toHaveBeenCalledOnce()
		const [pinned, fields, recordedWork] = record.mock.calls[0]
		expect(pinned.sessionManager.getSessionId()).toBe("original-session")
		expect(recordedWork).toBe("original-work")
		expect(fields).toMatchObject({
			type: "commit",
			toolCallId: "commit-tool",
			sha: git(repository, "rev-parse", "HEAD"),
		})
	})
})
