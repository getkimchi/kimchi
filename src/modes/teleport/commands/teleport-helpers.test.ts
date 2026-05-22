import { execSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	cloneRepoOnSandbox,
	propagateGitConfigToSandbox,
	propagateGitCredentialToSandbox,
	readLocalGitConfig,
} from "./teleport-helpers.js"

describe("readLocalGitConfig", () => {
	let savedGlobal: string | undefined
	let savedSystem: string | undefined

	beforeEach(() => {
		// Prevent global/system git config from leaking into tests
		savedGlobal = process.env.GIT_CONFIG_GLOBAL
		savedSystem = process.env.GIT_CONFIG_SYSTEM
		process.env.GIT_CONFIG_GLOBAL = "/dev/null"
		process.env.GIT_CONFIG_SYSTEM = "/dev/null"
	})

	afterEach(() => {
		if (savedGlobal === undefined) process.env.GIT_CONFIG_GLOBAL = undefined
		else process.env.GIT_CONFIG_GLOBAL = savedGlobal
		if (savedSystem === undefined) process.env.GIT_CONFIG_SYSTEM = undefined
		else process.env.GIT_CONFIG_SYSTEM = savedSystem
	})

	it("returns name and email from a git repo", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "git-cfg-test-"))
		try {
			execSync("git init", {
				cwd: tmp,
				stdio: "ignore",
				env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
			})
			execSync('git config user.name "Test User"', {
				cwd: tmp,
				stdio: "ignore",
				env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
			})
			execSync('git config user.email "test@example.com"', {
				cwd: tmp,
				stdio: "ignore",
				env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
			})
			const result = await readLocalGitConfig(tmp)
			expect(result.name).toBe("Test User")
			expect(result.email).toBe("test@example.com")
		} finally {
			rmSync(tmp, { recursive: true, force: true })
		}
	})

	it("returns undefined for both when not in a git repo", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "git-cfg-norepo-"))
		try {
			const result = await readLocalGitConfig(tmp)
			expect(result.name).toBeUndefined()
			expect(result.email).toBeUndefined()
		} finally {
			rmSync(tmp, { recursive: true, force: true })
		}
	})

	it("returns undefined for a value that is not set", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "git-cfg-partial-"))
		try {
			execSync("git init", {
				cwd: tmp,
				stdio: "ignore",
				env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
			})
			execSync('git config user.name "Only Name"', {
				cwd: tmp,
				stdio: "ignore",
				env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
			})
			const result = await readLocalGitConfig(tmp)
			expect(result.name).toBe("Only Name")
			expect(result.email).toBeUndefined()
		} finally {
			rmSync(tmp, { recursive: true, force: true })
		}
	})
})

function createMockSpawn(exitCode: number, stdinCapture?: Buffer[]) {
	const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = []
	const spawner = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
		const callIdx = calls.length
		calls.push({ cmd, args, opts })
		const child = new EventEmitter()
		const stdinStream = new PassThrough()
		;(child as unknown as { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }).stdin = stdinStream
		;(child as unknown as { stdout: PassThrough }).stdout = new PassThrough()
		;(child as unknown as { stderr: PassThrough }).stderr = new PassThrough()
		const chunks: Buffer[] = []
		stdinStream.on("data", (chunk: Buffer) => chunks.push(chunk))
		stdinStream.on("end", () => {
			if (stdinCapture) stdinCapture[callIdx] = Buffer.concat(chunks)
			// Emit close only after stdin is fully consumed so tests can inspect it
			child.emit("close", exitCode)
		})
		// For calls with no stdin the stream is never written — emit close next tick
		process.nextTick(() => {
			if (chunks.length === 0) child.emit("close", exitCode)
		})
		return child
	}) as unknown as typeof import("node:child_process").spawn
	return { spawner, calls }
}

describe("propagateGitConfigToSandbox", () => {
	const baseOpts = {
		remoteHost: "test-host",
		remoteUser: "sandbox",
		authToken: "test-token",
		proxyCommand: "fake-proxy %h",
	}

	it("sets both name and email via ssh", async () => {
		const { spawner, calls } = createMockSpawn(0)
		await propagateGitConfigToSandbox({
			...baseOpts,
			gitName: "Alice",
			gitEmail: "alice@example.com",
			_spawn: spawner,
		})
		// One SSH call per config key (no && chaining — sandbox uses ForceCommand=git)
		expect(calls).toHaveLength(2)
		expect(calls[0].cmd).toBe("ssh")
		const cmd1 = calls[0].args[calls[0].args.length - 1]
		expect(cmd1).toContain("git config --global user.name")
		expect(cmd1).toContain("'Alice'")
		const cmd2 = calls[1].args[calls[1].args.length - 1]
		expect(cmd2).toContain("git config --global user.email")
		expect(cmd2).toContain("'alice@example.com'")
	})

	it("sets only name when email is undefined", async () => {
		const { spawner, calls } = createMockSpawn(0)
		await propagateGitConfigToSandbox({
			...baseOpts,
			gitName: "Bob",
			_spawn: spawner,
		})
		expect(calls).toHaveLength(1)
		const remoteCmd = calls[0].args[calls[0].args.length - 1]
		expect(remoteCmd).toContain("git config --global user.name")
		expect(remoteCmd).not.toContain("user.email")
	})

	it("sets only email when name is undefined", async () => {
		const { spawner, calls } = createMockSpawn(0)
		await propagateGitConfigToSandbox({
			...baseOpts,
			gitEmail: "carol@example.com",
			_spawn: spawner,
		})
		expect(calls).toHaveLength(1)
		const remoteCmd = calls[0].args[calls[0].args.length - 1]
		expect(remoteCmd).toContain("git config --global user.email")
		expect(remoteCmd).not.toContain("user.name")
	})

	it("does nothing when both name and email are undefined", async () => {
		const { spawner, calls } = createMockSpawn(0)
		await propagateGitConfigToSandbox({
			...baseOpts,
			_spawn: spawner,
		})
		expect(calls).toHaveLength(0)
	})

	it("rejects when ssh exits with non-zero code", async () => {
		const { spawner } = createMockSpawn(1)
		await expect(
			propagateGitConfigToSandbox({
				...baseOpts,
				gitName: "Dave",
				_spawn: spawner,
			}),
		).rejects.toThrow("ssh exited with code 1")
	})

	it("shell-escapes values containing single quotes", async () => {
		const { spawner, calls } = createMockSpawn(0)
		await propagateGitConfigToSandbox({
			...baseOpts,
			gitName: "O'Brien",
			_spawn: spawner,
		})
		const remoteCmd = calls[0].args[calls[0].args.length - 1]
		expect(remoteCmd).toContain("'O'\\''Brien'")
	})

	it("passes AUTH_TOKEN in the environment", async () => {
		const { spawner, calls } = createMockSpawn(0)
		await propagateGitConfigToSandbox({
			...baseOpts,
			gitName: "Eve",
			_spawn: spawner,
		})
		const opts = calls[0].opts as { env?: Record<string, string> }
		expect(opts.env?.AUTH_TOKEN).toBe("test-token")
	})

	it("includes correct SSH options", async () => {
		const { spawner, calls } = createMockSpawn(0)
		await propagateGitConfigToSandbox({
			...baseOpts,
			gitName: "Frank",
			_spawn: spawner,
		})
		const args = calls[0].args
		expect(args).toContain("-T")
		expect(args).toContain("StrictHostKeyChecking=no")
		expect(args).toContain("UserKnownHostsFile=/dev/null")
		expect(args).toContain("BatchMode=yes")
		expect(args).toContain("LogLevel=ERROR")
		expect(args).toContain("sandbox@test-host")
		expect(args).toContain("ProxyCommand=fake-proxy %h")
		// Remote command is a single string arg at the end
		const remoteCmd = args[args.length - 1]
		expect(remoteCmd).toContain("git config --global")
	})
})

describe("propagateGitCredentialToSandbox", () => {
	const baseOpts = {
		remoteHost: "test-host",
		remoteUser: "sandbox",
		authToken: "test-token",
		proxyCommand: "fake-proxy %h",
		gitHost: "github.com",
		gitToken: "ghp_supersecret",
	}

	it("runs credential.helper cache, credential approve, and insteadOf rewrite", async () => {
		const { spawner, calls } = createMockSpawn(0)
		await propagateGitCredentialToSandbox({ ...baseOpts, _spawn: spawner })
		expect(calls).toHaveLength(3)
		// First call: credential.helper cache with 24h timeout
		const cmd1 = calls[0].args[calls[0].args.length - 1]
		expect(cmd1).toContain("git config --global credential.helper")
		expect(cmd1).toContain("cache --timeout=86400")
		// Second call: git credential approve
		const cmd2 = calls[1].args[calls[1].args.length - 1]
		expect(cmd2).toBe("git credential approve")
		// Third call: insteadOf rewrite for SSH URLs
		const cmd3 = calls[2].args[calls[2].args.length - 1]
		expect(cmd3).toContain("url.https://github.com/.insteadOf")
		expect(cmd3).toContain("'git@github.com:'")
	})

	it("pipes the credential block via stdin to credential approve", async () => {
		const stdinCapture: Buffer[] = []
		const { spawner } = createMockSpawn(0, stdinCapture)
		await propagateGitCredentialToSandbox({ ...baseOpts, _spawn: spawner })
		// The approve call (index 1) receives stdin
		const stdinText = stdinCapture[1]?.toString("utf-8") ?? ""
		expect(stdinText).toContain("protocol=https")
		expect(stdinText).toContain("host=github.com")
		expect(stdinText).toContain("username=oauth2")
		expect(stdinText).toContain("password=ghp_supersecret")
	})

	it("uses oauth2 as the default username", async () => {
		const stdinCapture: Buffer[] = []
		const { spawner } = createMockSpawn(0, stdinCapture)
		await propagateGitCredentialToSandbox({ ...baseOpts, _spawn: spawner })
		const stdinText = stdinCapture[1]?.toString("utf-8") ?? ""
		expect(stdinText).toContain("username=oauth2")
	})

	it("respects a custom gitUsername", async () => {
		const stdinCapture: Buffer[] = []
		const { spawner } = createMockSpawn(0, stdinCapture)
		await propagateGitCredentialToSandbox({ ...baseOpts, gitUsername: "myuser", _spawn: spawner })
		const stdinText = stdinCapture[1]?.toString("utf-8") ?? ""
		expect(stdinText).toContain("username=myuser")
	})

	it("rejects when ssh exits with non-zero code", async () => {
		const { spawner } = createMockSpawn(1)
		await expect(propagateGitCredentialToSandbox({ ...baseOpts, _spawn: spawner })).rejects.toThrow(
			"ssh exited with code 1",
		)
	})

	it("passes AUTH_TOKEN in the environment", async () => {
		const { spawner, calls } = createMockSpawn(0)
		await propagateGitCredentialToSandbox({ ...baseOpts, _spawn: spawner })
		const opts = calls[0].opts as { env?: Record<string, string> }
		expect(opts.env?.AUTH_TOKEN).toBe("test-token")
	})
})

describe("cloneRepoOnSandbox", () => {
	it("runs git clone with branch and --single-branch and --depth 1 by default", async () => {
		const { spawner, calls } = createMockSpawn(0)

		await cloneRepoOnSandbox({
			remoteHost: "host.example.com",
			remoteUser: "sandbox",
			authToken: "test-token",
			repoUrl: "https://github.com/org/repo.git",
			destination: "/home/sandbox/repo/",
			branch: "feature-x",
			proxyCommand: "fake-proxy %h",
			_spawn: spawner,
		})

		expect(calls).toHaveLength(1)
		// The last SSH arg is the remote command
		const remoteCmd = calls[0].args[calls[0].args.length - 1]
		expect(remoteCmd).toContain("git clone")
		expect(remoteCmd).toContain("--depth 1")
		expect(remoteCmd).toContain("--branch")
		expect(remoteCmd).toContain("'feature-x'")
		expect(remoteCmd).toContain("--single-branch")
		expect(remoteCmd).toContain("'https://github.com/org/repo.git'")
		expect(remoteCmd).toContain("'/home/sandbox/repo/'")
	})

	it("runs git clone without branch flags when branch is omitted", async () => {
		const { spawner, calls } = createMockSpawn(0)

		await cloneRepoOnSandbox({
			remoteHost: "host.example.com",
			remoteUser: "sandbox",
			authToken: "test-token",
			repoUrl: "https://github.com/org/repo.git",
			destination: "/home/sandbox/repo/",
			proxyCommand: "fake-proxy %h",
			_spawn: spawner,
		})

		const remoteCmd = calls[0].args[calls[0].args.length - 1]
		expect(remoteCmd).toContain("git clone")
		expect(remoteCmd).toContain("--depth 1")
		expect(remoteCmd).not.toContain("--branch")
		expect(remoteCmd).not.toContain("--single-branch")
	})

	it("omits --depth when shallow is false", async () => {
		const { spawner, calls } = createMockSpawn(0)

		await cloneRepoOnSandbox({
			remoteHost: "host.example.com",
			remoteUser: "sandbox",
			authToken: "test-token",
			repoUrl: "https://github.com/org/repo.git",
			destination: "/home/sandbox/repo/",
			shallow: false,
			proxyCommand: "fake-proxy %h",
			_spawn: spawner,
		})

		const remoteCmd = calls[0].args[calls[0].args.length - 1]
		expect(remoteCmd).toContain("git clone")
		expect(remoteCmd).not.toContain("--depth")
	})

	it("rejects when ssh exits non-zero", async () => {
		const { spawner } = createMockSpawn(128)

		await expect(
			cloneRepoOnSandbox({
				remoteHost: "host.example.com",
				remoteUser: "sandbox",
				authToken: "test-token",
				repoUrl: "https://github.com/org/repo.git",
				destination: "/home/sandbox/repo/",
				proxyCommand: "fake-proxy %h",
				_spawn: spawner,
			}),
		).rejects.toThrow(/ssh exited with code 128/)
	})
})
