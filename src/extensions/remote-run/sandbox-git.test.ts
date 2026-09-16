import type { ChildProcess, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import {
	buildSandboxGitRemoteCommand,
	buildSandboxGitSshArgv,
	captureBaseline,
	parsePorcelainPaths,
	recoverBaseShaFromMergeBase,
	runSandboxGit,
	type SandboxGitConnection,
	SandboxGitError,
	shellQuote,
} from "./sandbox-git.js"

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

describe("shellQuote", () => {
	it("wraps in single quotes and escapes embedded quotes", () => {
		expect(shellQuote("abc")).toBe("'abc'")
		expect(shellQuote("it's")).toBe(String.raw`'it'\''s'`)
		expect(shellQuote("a b'c\"d $x `y`")).toBe("'a b'\\''c\"d $x `y`'")
	})
})

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

describe("buildSandboxGitSshArgv", () => {
	it("matches the rsync-runner ssh option layout plus keepalive", () => {
		const argv = buildSandboxGitSshArgv({
			host: "h",
			remoteUser: "u",
			proxyCommand: "node proxy.js %h %p",
			knownHostsFile: "/tmp/kh",
			remoteCommand: "git -C '/w' 'status' '--porcelain'",
		})
		expect(argv).toEqual([
			"-o",
			"ProxyCommand=node proxy.js %h %p",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			"UserKnownHostsFile=/tmp/kh",
			"-o",
			"BatchMode=yes",
			"-o",
			"ServerAliveInterval=15",
			"u@h",
			"git -C '/w' 'status' '--porcelain'",
		])
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
			{ match: "merge-base", stdout: `${sha}\n` },
		])
		const spawner = vi.fn((binary: string, args: string[]) => {
			commands.push(args[args.length - 1] as string)
			return base(binary, args)
		}) as unknown as typeof spawn

		const got = await recoverBaseShaFromMergeBase(CONNECTION, "main", { apiKey: "k", _spawn: spawner })

		expect(got).toBe(sha)
		expect(commands).toEqual([
			"git -C '/home/sandbox/acp-deadbeef' 'fetch' '--no-tags' 'origin' 'main'",
			"git -C '/home/sandbox/acp-deadbeef' 'merge-base' 'origin/main' 'HEAD'",
		])
	})

	it("falls back to the local base-branch ref and returns undefined when there is no fork point", async () => {
		const spawner = mergeBaseSpawner([
			{ match: "fetch", stdout: "" },
			// origin/main merge-base fails; plain main succeeds
		])

		// First call (origin/main) fails → second (main) succeeds? both fail here → undefined.
		const got = await recoverBaseShaFromMergeBase(CONNECTION, "main", { apiKey: "k", _spawn: spawner })

		expect(got).toBeUndefined()
	})
})
