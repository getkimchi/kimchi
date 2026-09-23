import type { ChildProcess, execFileSync, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import {
	buildSandboxGitRemoteCommand,
	captureBaseline,
	classifyPushFailure,
	parsePorcelainPaths,
	pullBranchLocally,
	pushBranchRemotely,
	pushViaLocalFallback,
	recoverBaseShaFromMergeBase,
	runSandboxGit,
	type SandboxGitConnection,
	SandboxGitError,
} from "./sandbox-git.js"

vi.mock("../../config.js", () => ({
	loadConfig: () => ({ apiKey: "test-key" }),
}))

const CONNECTION: SandboxGitConnection = {
	host: "session-host.example",
	remoteUser: "sandbox",
	authToken: "tok-123",
	cwd: "/home/sandbox/acp-deadbeef",
}

interface FakeChildResult {
	code?: number
	stdout?: string
	stderr?: string
	/** Split into separate data events. */
	stdoutChunks?: string[]
	error?: Error
}

function fakeSpawn(result: FakeChildResult): typeof spawn {
	return vi.fn((_binary: string, _args: string[], _opts: unknown) => {
		const child = new EventEmitter() as ChildProcess
		child.stdout = new EventEmitter() as ChildProcess["stdout"]
		child.stderr = new EventEmitter() as ChildProcess["stderr"]
		process.nextTick(() => {
			if (result.error) {
				child.emit("error", result.error)
				return
			}
			const chunks = result.stdoutChunks ?? (result.stdout !== undefined ? [result.stdout] : [])
			for (const chunk of chunks) child.stdout?.emit("data", Buffer.from(chunk, "utf-8"))
			if (result.stderr !== undefined) child.stderr?.emit("data", Buffer.from(result.stderr, "utf-8"))
			child.emit("close", result.code ?? 0)
		})
		return child
	}) as unknown as typeof spawn
}

function spawnedArgv(spawner: typeof spawn): { binary: string; args: string[] } {
	const mock = spawner as unknown as ReturnType<typeof vi.fn>
	const [binary, args] = mock.mock.calls[0] as unknown as [string, string[], unknown]
	return { binary, args }
}

describe("buildSandboxGitRemoteCommand", () => {
	it("quotes the cwd and every git arg", () => {
		expect(buildSandboxGitRemoteCommand("/home/sandbox/acp-x", ["status", "--porcelain"])).toBe(
			"git -C '/home/sandbox/acp-x' 'status' '--porcelain'",
		)
	})

	it("keeps spaces and metacharacters inside single-quoted tokens", () => {
		expect(buildSandboxGitRemoteCommand("/tmp/dir with space", ["log", "--format=%h %s", "HEAD~1..HEAD"])).toBe(
			"git -C '/tmp/dir with space' 'log' '--format=%h %s' 'HEAD~1..HEAD'",
		)
	})
})

describe("runSandboxGit", () => {
	it("spawns ssh with the connection's host/user and the quoted git command", async () => {
		const spawner = fakeSpawn({ stdout: "ok\n" })
		const result = await runSandboxGit({
			connection: CONNECTION,
			args: ["rev-parse", "HEAD"],
			apiKey: "key",
			proxyCommand: "proxy %h %p",
			_spawn: spawner,
		})
		expect(result).toEqual({ stdout: "ok\n", stderr: "" })
		const { binary, args } = spawnedArgv(spawner)
		expect(binary).toBe("ssh")
		expect(args[args.length - 2]).toBe("sandbox@session-host.example")
		expect(args[args.length - 1]).toBe("git -C '/home/sandbox/acp-deadbeef' 'rev-parse' 'HEAD'")
	})

	it("injects AUTH_TOKEN and KIMCHI_API_KEY into the child env", async () => {
		const spawner = fakeSpawn({ stdout: "" })
		await runSandboxGit({ connection: CONNECTION, args: ["status"], apiKey: "key-42", _spawn: spawner })
		const env = (spawner as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2].env as NodeJS.ProcessEnv
		expect(env.AUTH_TOKEN).toBe("tok-123")
		expect(env.KIMCHI_API_KEY).toBe("key-42")
	})

	it("streams stdout chunks to onStdoutChunk while accumulating them", async () => {
		const spawner = fakeSpawn({ stdoutChunks: ["diff --git", " a/f.ts", "+line"] })
		const chunks: string[] = []
		const result = await runSandboxGit({
			connection: CONNECTION,
			args: ["diff", "abc...def"],
			apiKey: "key",
			onStdoutChunk: (c) => chunks.push(c),
			_spawn: spawner,
		})
		expect(chunks).toEqual(["diff --git", " a/f.ts", "+line"])
		expect(result.stdout).toBe("diff --git a/f.ts+line")
	})

	it("rejects with SandboxGitError carrying exit code and stderr on non-zero exit", async () => {
		const spawner = fakeSpawn({ code: 128, stderr: "fatal: not a git repository" })
		const err = await runSandboxGit({ connection: CONNECTION, args: ["status"], apiKey: "k", _spawn: spawner }).catch(
			(e) => e,
		)
		expect(err).toBeInstanceOf(SandboxGitError)
		expect(err.exitCode).toBe(128)
		expect(err.stderr).toBe("fatal: not a git repository")
	})

	it("rejects with the spawn error itself", async () => {
		const spawner = fakeSpawn({ error: new Error("spawn ssh ENOENT") })
		const err = await runSandboxGit({ connection: CONNECTION, args: ["status"], apiKey: "k", _spawn: spawner }).catch(
			(e) => e,
		)
		expect(err).not.toBeInstanceOf(SandboxGitError)
		expect(err.message).toBe("spawn ssh ENOENT")
	})

	it("forwards the abort signal to the child", async () => {
		const controller = new AbortController()
		const spawner = fakeSpawn({ stdout: "" })
		await runSandboxGit({
			connection: CONNECTION,
			args: ["status"],
			apiKey: "k",
			signal: controller.signal,
			_spawn: spawner,
		})
		expect((spawner as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2].signal).toBe(controller.signal)
	})
})

describe("parsePorcelainPaths", () => {
	it("parses modified, untracked, and staged entries", () => {
		expect(parsePorcelainPaths(" M src/a.ts\n?? new-file.md\nM  staged.ts\n")).toEqual([
			"src/a.ts",
			"new-file.md",
			"staged.ts",
		])
	})

	it("keeps the new path of rename entries", () => {
		expect(parsePorcelainPaths("R  old-name.ts -> new-name.ts")).toEqual(["new-name.ts"])
	})

	it("strips C-quotes from quoted paths", () => {
		expect(parsePorcelainPaths('?? "file with spaces.txt"')).toEqual(["file with spaces.txt"])
	})

	it("ignores empty lines and tolerates CRLF", () => {
		expect(parsePorcelainPaths(" M a.ts\r\n\r\n?? b.ts")).toEqual(["a.ts", "b.ts"])
	})
})

describe("captureBaseline", () => {
	it("runs rev-parse then status over the same connection and parses both", async () => {
		const sha = "0123456789abcdef0123456789abcdef01234567"
		const commands: string[] = []
		const spawner = vi.fn((_binary: string, args: string[]) => {
			const remoteCommand = args[args.length - 1]
			commands.push(remoteCommand)
			const result = remoteCommand.includes("rev-parse")
				? { stdout: `${sha}\n` }
				: { stdout: " M dirty.ts\n?? new.ts\n" }
			const child = new EventEmitter() as ChildProcess
			child.stdout = new EventEmitter() as ChildProcess["stdout"]
			child.stderr = new EventEmitter() as ChildProcess["stderr"]
			process.nextTick(() => {
				child.stdout?.emit("data", Buffer.from(result.stdout, "utf-8"))
				child.emit("close", 0)
			})
			return child
		}) as unknown as typeof spawn

		const baseline = await captureBaseline(CONNECTION, { apiKey: "k", _spawn: spawner })
		expect(baseline).toEqual({ baseSha: sha, dirtyFiles: ["dirty.ts", "new.ts"] })
		expect(commands).toEqual([
			"git -C '/home/sandbox/acp-deadbeef' 'rev-parse' 'HEAD'",
			"git -C '/home/sandbox/acp-deadbeef' 'status' '--porcelain'",
		])
	})

	it("rejects when rev-parse returns something that is not a 40-char SHA", async () => {
		const spawner = fakeSpawn({ stdout: "not-a-sha\n" })
		await expect(captureBaseline(CONNECTION, { apiKey: "k", _spawn: spawner })).rejects.toThrow(
			/unexpected rev-parse output/,
		)
	})

	it("propagates SandboxGitError from the first failing command", async () => {
		const spawner = fakeSpawn({ code: 1, stderr: "fatal" })
		await expect(captureBaseline(CONNECTION, { apiKey: "k", _spawn: spawner })).rejects.toThrow(SandboxGitError)
	})
})

describe("recoverBaseShaFromMergeBase", () => {
	function mergeBaseSpawner(responses: Array<{ match: string; stdout: string; code?: number }>) {
		return vi.fn((_binary: string, args: string[]) => {
			const remoteCommand = args[args.length - 1]
			const hit = responses.find((r) => remoteCommand.includes(r.match)) ?? { stdout: "", code: 1 }
			const child = new EventEmitter() as ChildProcess
			child.stdout = new EventEmitter() as ChildProcess["stdout"]
			child.stderr = new EventEmitter() as ChildProcess["stderr"]
			process.nextTick(() => {
				child.stdout?.emit("data", Buffer.from(hit.stdout, "utf-8"))
				child.emit("close", hit.code ?? 0)
			})
			return child
		}) as unknown as typeof spawn
	}

	it("resolves via origin/<baseBranch> after a best-effort fetch", async () => {
		const sha = "c".repeat(40)
		const commands: string[] = []
		const base = mergeBaseSpawner([
			{ match: "fetch", stdout: "" },
			{ match: "for-each-ref", stdout: "origin/HEAD\norigin/main\n" },
			{ match: "merge-base", stdout: `${sha}\n` },
		])
		const spawner = vi.fn((binary: string, args: string[]) => {
			commands.push(args[args.length - 1] as string)
			return base(binary, args)
		}) as unknown as typeof spawn

		const got = await recoverBaseShaFromMergeBase(CONNECTION, "main", { apiKey: "k", _spawn: spawner })

		expect(got).toBe(sha)
		expect(commands).toEqual([
			"git -C '/home/sandbox/acp-deadbeef' 'fetch' '--no-tags' 'origin'",
			"git -C '/home/sandbox/acp-deadbeef' 'fetch' '--no-tags' 'origin' 'main'",
			"git -C '/home/sandbox/acp-deadbeef' 'for-each-ref' '--format=%(refname:short)' 'refs/remotes/origin/'",
			"git -C '/home/sandbox/acp-deadbeef' 'merge-base' 'origin/main' 'HEAD'",
		])
	})

	it("falls back through origin/HEAD and every remote ref before giving up", async () => {
		// merge-base succeeds only for origin/release-2 — the baseBranch name
		// was wrong (real failure mode: master vs main drift, shallow clones).
		const sha = "d".repeat(40)
		const commands: string[] = []
		const base = mergeBaseSpawner([
			{ match: "fetch", stdout: "" },
			{ match: "for-each-ref", stdout: "origin/HEAD\norigin/master\norigin/release-1\norigin/release-2\n" },
			{ match: "release-2", stdout: `${sha}\n` },
		])
		const spawner = vi.fn((binary: string, args: string[]) => {
			commands.push(args[args.length - 1] as string)
			return base(binary, args)
		}) as unknown as typeof spawn

		const got = await recoverBaseShaFromMergeBase(CONNECTION, "master", { apiKey: "k", _spawn: spawner })

		expect(got).toBe(sha)
		// merge-base probes: origin/master, master, origin/HEAD, origin/release-1, origin/release-2
		expect(commands.filter((c) => c.includes("merge-base"))).toEqual([
			"git -C '/home/sandbox/acp-deadbeef' 'merge-base' 'origin/master' 'HEAD'",
			"git -C '/home/sandbox/acp-deadbeef' 'merge-base' 'master' 'HEAD'",
			"git -C '/home/sandbox/acp-deadbeef' 'merge-base' 'origin/HEAD' 'HEAD'",
			"git -C '/home/sandbox/acp-deadbeef' 'merge-base' 'origin/release-1' 'HEAD'",
			"git -C '/home/sandbox/acp-deadbeef' 'merge-base' 'origin/release-2' 'HEAD'",
		])
	})

	it("returns undefined when no remote ref shares a fork point", async () => {
		const spawner = mergeBaseSpawner([{ match: "fetch", stdout: "" }])

		const got = await recoverBaseShaFromMergeBase(CONNECTION, "main", { apiKey: "k", _spawn: spawner })

		expect(got).toBeUndefined()
	})
})

describe("classifyPushFailure", () => {
	it("maps the known stderr shapes", () => {
		expect(classifyPushFailure("! [rejected] main -> main (non-fast-forward)").kind).toBe("non-fast-forward")
		expect(classifyPushFailure("error: failed to push some refs — hint: fetch first").kind).toBe("non-fast-forward")
		expect(classifyPushFailure("git@github.com: Permission denied (publickey).").kind).toBe("auth")
		expect(classifyPushFailure("remote: Invalid username or password. Authentication failed").kind).toBe("auth")
		expect(classifyPushFailure("fatal: unable to access 'https://x': The requested URL returned error: 403").kind).toBe(
			"auth",
		)
		expect(classifyPushFailure("ssh: connect to host x port 22: Connection refused").kind).toBe("transport")
		expect(classifyPushFailure("ssh: Could not resolve hostname x: Name or service not known").kind).toBe("transport")
		expect(classifyPushFailure("something totally unexpected").kind).toBe("unknown")
	})

	it("auth classification points at the local fallback explicitly", () => {
		const failure = classifyPushFailure("Permission denied (publickey).")
		expect(failure.reason).toContain("local fallback")
	})
})

describe("pushBranchRemotely", () => {
	it("pushes -u origin <branch> via runSandboxGit and reports ok", async () => {
		const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "" })

		const result = await pushBranchRemotely({ connection: CONNECTION, branch: "kimchi/fix", _runSandboxGit: run })

		expect(result).toEqual({ ok: true })
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({ connection: CONNECTION, args: ["push", "-u", "origin", "kimchi/fix"] }),
		)
	})

	it("classifies a rejected push instead of throwing", async () => {
		const run = vi
			.fn()
			.mockRejectedValue(
				new SandboxGitError(128, "remote: Permission to repo denied\nfatal: unable to access 'https://x': 403"),
			)

		const result = await pushBranchRemotely({ connection: CONNECTION, branch: "kimchi/fix", _runSandboxGit: run })

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.failure.kind).toBe("auth")
	})
})

describe("pushViaLocalFallback", () => {
	it("fetches into refs/kimchi-push/<branch> via GIT_SSH_COMMAND then pushes with ambient env", async () => {
		const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined; cwd: string | undefined }> =
			[]
		const execFile = vi.fn((cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
			calls.push({ cmd, args, env: opts.env, cwd: opts.cwd })
			return Buffer.from("")
		}) as unknown as typeof execFileSync

		const result = await pushViaLocalFallback({
			connection: CONNECTION,
			branch: "kimchi/fix",
			localRepo: "/repo",
			execFile,
		})

		expect(result).toEqual({ ok: true })
		expect(calls).toHaveLength(3)

		// Fetch: into the staging ref only — never refs/heads, never the worktree.
		expect(calls[0]?.args[0]).toBe("fetch")
		expect(calls[0]?.args[1]).toBe("--no-tags")
		expect(calls[0]?.args[2]).toBe("ssh://sandbox@session-host.example/home/sandbox/acp-deadbeef")
		expect(calls[0]?.args[3]).toBe("+refs/heads/kimchi/fix:refs/kimchi-push/kimchi/fix")
		expect(calls[0]?.cwd).toBe("/repo")
		const fetchSsh = calls[0]?.env?.GIT_SSH_COMMAND ?? ""
		expect(fetchSsh).toContain("ProxyCommand=")
		expect(fetchSsh).toContain("BatchMode=yes")
		expect(calls[0]?.env?.AUTH_TOKEN).toBe("tok-123")
		expect(calls[0]?.env?.KIMCHI_API_KEY).toBe("test-key")

		// Push: staging ref onto the real branch, ambient env (no GIT_SSH_COMMAND override).
		expect(calls[1]?.args).toEqual(["push", "-u", "origin", "refs/kimchi-push/kimchi/fix:refs/heads/kimchi/fix"])
		expect(calls[1]?.env).toBeUndefined()

		// The staging ref is deleted after the push — never left in the user's repo.
		expect(calls[2]?.args).toEqual(["update-ref", "-d", "refs/kimchi-push/kimchi/fix"])
	})

	it("deletes the staging ref even when the local push fails", async () => {
		const calls: string[][] = []
		const execFile = vi.fn((_cmd: string, args: string[]) => {
			calls.push(args)
			if (args[0] === "push") {
				throw Object.assign(new Error("push failed"), { stderr: Buffer.from("! [rejected] (non-fast-forward)") })
			}
			return Buffer.from("")
		}) as unknown as typeof execFileSync

		const result = await pushViaLocalFallback({
			connection: CONNECTION,
			branch: "kimchi/fix",
			localRepo: "/repo",
			execFile,
		})

		expect(result.ok).toBe(false)
		expect(calls[2]).toEqual(["update-ref", "-d", "refs/kimchi-push/kimchi/fix"])
	})

	it("classifies a local push rejection", async () => {
		const failure = Object.assign(new Error("push failed"), {
			stderr: Buffer.from("! [rejected] refs/heads/kimchi/fix (non-fast-forward)"),
		})
		const execFile = vi.fn((_cmd: string, args: string[]) => {
			if (args[0] === "push") throw failure
			return Buffer.from("")
		}) as unknown as typeof execFileSync

		const result = await pushViaLocalFallback({
			connection: CONNECTION,
			branch: "kimchi/fix",
			localRepo: "/repo",
			execFile,
		})

		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.failure.kind).toBe("non-fast-forward")
	})
})

describe("pullBranchLocally", () => {
	it("creates a tracking branch when the local branch does not exist", () => {
		const execFile = vi.fn((_cmd: string, args: string[]) => {
			if (args[0] === "rev-parse") throw new Error("not found")
			return Buffer.from("")
		}) as unknown as typeof execFileSync

		const result = pullBranchLocally({ localRepo: "/repo", branch: "kimchi/fix", execFile })

		expect(result).toEqual({ kind: "pulled", action: "created" })
		const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string[])
		expect(calls).toEqual([
			["fetch", "--no-tags", "origin", "kimchi/fix"],
			["rev-parse", "--verify", "refs/heads/kimchi/fix"],
			["switch", "-c", "kimchi/fix", "--track", "origin/kimchi/fix"],
		])
	})

	it("fast-forwards an existing local branch", () => {
		const execFile = vi.fn(() => Buffer.from("")) as unknown as typeof execFileSync

		const result = pullBranchLocally({ localRepo: "/repo", branch: "kimchi/fix", execFile })

		expect(result).toEqual({ kind: "pulled", action: "fast-forwarded" })
		const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string[])
		expect(calls).toEqual([
			["fetch", "--no-tags", "origin", "kimchi/fix"],
			["rev-parse", "--verify", "refs/heads/kimchi/fix"],
			["switch", "kimchi/fix"],
			["merge", "--ff-only", "origin/kimchi/fix"],
		])
	})

	it("reports failure honestly with manual commands on diverged branch", () => {
		const execFile = vi.fn((_cmd: string, args: string[]) => {
			if (args[0] === "merge")
				throw Object.assign(new Error("merge failed"), { stderr: Buffer.from("fatal: Not possible to fast-forward") })
			return Buffer.from("")
		}) as unknown as typeof execFileSync

		const result = pullBranchLocally({ localRepo: "/repo", branch: "kimchi/fix", execFile })

		expect(result.kind).toBe("failed")
		if (result.kind === "failed") {
			expect(result.reason).toContain("Not possible to fast-forward")
			expect(result.command).toBe(
				"git fetch origin kimchi/fix && git switch kimchi/fix && git merge --ff-only origin/kimchi/fix",
			)
		}
	})

	it("reports fetch failures with manual commands", () => {
		const execFile = vi.fn(() => {
			throw Object.assign(new Error("fetch failed"), {
				stderr: Buffer.from("fatal: 'origin' does not appear to be a git repository"),
			})
		}) as unknown as typeof execFileSync

		const result = pullBranchLocally({ localRepo: "/repo", branch: "kimchi/fix", execFile })

		expect(result.kind).toBe("failed")
		if (result.kind === "failed") expect(result.reason).toContain("does not appear to be a git repository")
	})
})
