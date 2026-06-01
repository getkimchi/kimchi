import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { cloneRepoOnSandbox, deriveSandboxDestFromRepoUrl } from "./git-clone.js"

function makeSpawn() {
	const calls: string[][] = []
	const spawn = (_command: string, args: readonly string[], _opts: unknown) => {
		calls.push([...args])
		const child = new EventEmitter() as EventEmitter & {
			stdin: PassThrough
			stdout: PassThrough
			stderr: PassThrough
		}
		child.stdin = new PassThrough()
		child.stdout = new PassThrough()
		child.stderr = new PassThrough()
		queueMicrotask(() => child.emit("close", 0))
		return child as unknown as ChildProcess
	}
	return { spawn, calls }
}

const COMMON = {
	remoteHost: "h.example",
	remoteUser: "sandbox",
	authToken: "tok",
	proxyCommand: "/tmp/proxy %h",
}

describe("deriveSandboxDestFromRepoUrl", () => {
	it("extracts repo name from HTTPS URLs and strips .git", () => {
		expect(deriveSandboxDestFromRepoUrl("https://github.com/me/my-repo.git")).toBe("/home/sandbox/my-repo/")
		expect(deriveSandboxDestFromRepoUrl("https://github.com/me/no-suffix")).toBe("/home/sandbox/no-suffix/")
	})

	it("handles SSH shorthand", () => {
		expect(deriveSandboxDestFromRepoUrl("git@github.com:me/repo.git")).toBe("/home/sandbox/repo/")
	})

	it("handles trailing slashes", () => {
		expect(deriveSandboxDestFromRepoUrl("https://github.com/me/repo/")).toBe("/home/sandbox/repo/")
	})

	it("falls back to 'workspace' when name cannot be derived", () => {
		expect(deriveSandboxDestFromRepoUrl("")).toBe("/home/sandbox/workspace/")
	})
})

describe("cloneRepoOnSandbox", () => {
	it("uses --depth 1 by default and shell-escapes url/destination", async () => {
		const { spawn, calls } = makeSpawn()
		await cloneRepoOnSandbox({
			...COMMON,
			repoUrl: "https://github.com/me/repo.git",
			destination: "/home/sandbox/repo/",
			_spawn: spawn as never,
		})
		expect(calls).toHaveLength(1)
		expect(calls[0]?.at(-1)).toBe("git clone --depth 1 'https://github.com/me/repo.git' '/home/sandbox/repo/'")
	})

	it("omits --depth when shallow=false", async () => {
		const { spawn, calls } = makeSpawn()
		await cloneRepoOnSandbox({
			...COMMON,
			repoUrl: "u",
			destination: "/d/",
			shallow: false,
			_spawn: spawn as never,
		})
		expect(calls[0]?.at(-1)).toBe("git clone 'u' '/d/'")
	})

	it("adds --branch and --single-branch when branch is set", async () => {
		const { spawn, calls } = makeSpawn()
		await cloneRepoOnSandbox({
			...COMMON,
			repoUrl: "u",
			destination: "/d/",
			branch: "main",
			_spawn: spawn as never,
		})
		expect(calls[0]?.at(-1)).toBe("git clone --depth 1 --branch 'main' --single-branch 'u' '/d/'")
	})

	it("shell-escapes a branch containing single quotes", async () => {
		const { spawn, calls } = makeSpawn()
		await cloneRepoOnSandbox({
			...COMMON,
			repoUrl: "u",
			destination: "/d/",
			branch: "weird'branch",
			_spawn: spawn as never,
		})
		expect(calls[0]?.at(-1)).toContain("--branch 'weird'\\''branch'")
	})
})
