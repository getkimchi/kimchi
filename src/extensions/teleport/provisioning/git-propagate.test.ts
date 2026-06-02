import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { propagateGitConfigToSandbox, propagateGitCredentialToSandbox } from "./git-propagate.js"

interface FakeChild extends EventEmitter {
	stdin: PassThrough
	stdout: PassThrough
	stderr: PassThrough
}

function makeFakeChild(): FakeChild {
	const emitter = new EventEmitter() as FakeChild
	emitter.stdin = new PassThrough()
	emitter.stdout = new PassThrough()
	emitter.stderr = new PassThrough()
	return emitter
}

interface SpawnCall {
	args: string[]
	stdin: Buffer
}

function makeSpawn() {
	const calls: SpawnCall[] = []
	const spawn = (_command: string, args: readonly string[], _opts: unknown) => {
		const child = makeFakeChild()
		const captured: Buffer[] = []
		child.stdin.on("data", (chunk: Buffer) => captured.push(chunk))
		const call = { args: [...args], stdin: Buffer.alloc(0) as Buffer }
		calls.push(call)
		// finalize stdin & emit close once stdin closes (mimics SSH lifecycle)
		child.stdin.on("finish", () => {
			call.stdin = Buffer.concat(captured)
			queueMicrotask(() => child.emit("close", 0))
		})
		// for stdin-less calls, no "finish" event ever fires — emit close ourselves.
		queueMicrotask(() => {
			if (!child.stdin.writableEnded) {
				// pretend remote did not consume stdin; treat as immediate completion.
				call.stdin = Buffer.concat(captured)
				child.emit("close", 0)
			}
		})
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

describe("propagateGitConfigToSandbox", () => {
	it("does nothing when both name and email are undefined", async () => {
		const { spawn, calls } = makeSpawn()
		await propagateGitConfigToSandbox({ ...COMMON, _spawn: spawn as never })
		expect(calls).toHaveLength(0)
	})

	it("issues one SSH call when only name is set", async () => {
		const { spawn, calls } = makeSpawn()
		await propagateGitConfigToSandbox({ ...COMMON, gitName: "Alice", _spawn: spawn as never })
		expect(calls).toHaveLength(1)
		expect(calls[0]?.args.at(-1)).toBe("git config --global user.name 'Alice'")
	})

	it("issues two SSH calls when both name and email are set, with shell-escaped values", async () => {
		const { spawn, calls } = makeSpawn()
		await propagateGitConfigToSandbox({
			...COMMON,
			gitName: "O'Brien",
			gitEmail: "ob@example.com",
			_spawn: spawn as never,
		})
		expect(calls).toHaveLength(2)
		expect(calls[0]?.args.at(-1)).toBe("git config --global user.name 'O'\\''Brien'")
		expect(calls[1]?.args.at(-1)).toBe("git config --global user.email 'ob@example.com'")
	})
})

describe("propagateGitCredentialToSandbox", () => {
	it("issues three SSH calls: helper, approve (with stdin), insteadOf rewrite", async () => {
		const { spawn, calls } = makeSpawn()
		await propagateGitCredentialToSandbox({
			...COMMON,
			gitHost: "github.com",
			gitToken: "ghp_x",
			_spawn: spawn as never,
		})

		expect(calls).toHaveLength(3)
		expect(calls[0]?.args.at(-1)).toBe("git config --global credential.helper 'cache --timeout=86400'")
		expect(calls[1]?.args.at(-1)).toBe("git credential approve")
		expect(calls[1]?.stdin.toString("utf-8")).toBe(
			["protocol=https", "host=github.com", "username=oauth2", "password=ghp_x", "", ""].join("\n"),
		)
		expect(calls[2]?.args.at(-1)).toBe("git config --global url.https://github.com/.insteadOf 'git@github.com:'")
	})

	it("uses a custom gitUsername when provided", async () => {
		const { spawn, calls } = makeSpawn()
		await propagateGitCredentialToSandbox({
			...COMMON,
			gitHost: "gitlab.com",
			gitToken: "tok",
			gitUsername: "alice",
			_spawn: spawn as never,
		})
		expect(calls[1]?.stdin.toString("utf-8")).toContain("username=alice")
	})
})
