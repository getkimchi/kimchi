import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { runSshCommandOnSandbox, shellEscapeValue } from "./ssh-exec.js"

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

function makeSpawn(child: FakeChild) {
	const calls: Array<{ command: string; args: string[]; options: unknown }> = []
	const spawn = (command: string, args: readonly string[], options: unknown) => {
		calls.push({ command, args: [...args], options })
		return child as unknown as ChildProcess
	}
	return { spawn, calls }
}

describe("shellEscapeValue", () => {
	it("wraps plain values in single quotes", () => {
		expect(shellEscapeValue("hello")).toBe("'hello'")
	})

	it("escapes inner single quotes as '\\''", () => {
		expect(shellEscapeValue("it's fine")).toBe("'it'\\''s fine'")
	})

	it("handles empty strings", () => {
		expect(shellEscapeValue("")).toBe("''")
	})
})

describe("runSshCommandOnSandbox", () => {
	it("spawns ssh with -T, ProxyCommand, host, and the remote command as a single arg", async () => {
		const child = makeFakeChild()
		const { spawn, calls } = makeSpawn(child)

		const promise = runSshCommandOnSandbox({
			remoteHost: "h.example",
			remoteUser: "sandbox",
			authToken: "tok-1",
			remoteCommand: "git config --global user.name 'alice'",
			proxyCommand: "/tmp/proxy %h",
			_spawn: spawn as never,
		})

		// finish successfully
		queueMicrotask(() => child.emit("close", 0))
		await promise

		expect(calls).toHaveLength(1)
		const call = calls[0]
		if (!call) throw new Error("expected one captured call")
		expect(call.command).toBe("ssh")
		expect(call.args).toContain("-T")
		expect(call.args).toContain("ProxyCommand=/tmp/proxy %h")
		expect(call.args).toContain("BatchMode=yes")
		expect(call.args).toContain("sandbox@h.example")
		expect(call.args.at(-1)).toBe("git config --global user.name 'alice'")
		const opts = call.options as { env: NodeJS.ProcessEnv; stdio: [string, string, string] }
		expect(opts.env.AUTH_TOKEN).toBe("tok-1")
		expect(opts.stdio[0]).toBe("ignore")
	})

	it("rejects with stderr-derived message on non-zero exit", async () => {
		const child = makeFakeChild()
		const { spawn } = makeSpawn(child)

		const promise = runSshCommandOnSandbox({
			remoteHost: "h",
			remoteUser: "sandbox",
			authToken: "tok",
			remoteCommand: "false",
			proxyCommand: "/tmp/proxy %h",
			_spawn: spawn as never,
		})

		queueMicrotask(() => {
			child.stderr.write(Buffer.from("permission denied"))
			child.emit("close", 42)
		})

		await expect(promise).rejects.toThrow(/exited with code 42.*permission denied/)
	})

	it("rejects on spawn error", async () => {
		const child = makeFakeChild()
		const { spawn } = makeSpawn(child)

		const promise = runSshCommandOnSandbox({
			remoteHost: "h",
			remoteUser: "sandbox",
			authToken: "tok",
			remoteCommand: "cmd",
			proxyCommand: "/tmp/proxy %h",
			_spawn: spawn as never,
		})

		queueMicrotask(() => child.emit("error", new Error("spawn failed")))

		await expect(promise).rejects.toThrow(/spawn failed/)
	})

	it("when stdin is provided, opens stdio[0]=pipe and writes the payload", async () => {
		const child = makeFakeChild()
		const { spawn, calls } = makeSpawn(child)
		const written: Buffer[] = []
		child.stdin.on("data", (chunk: Buffer) => {
			written.push(chunk)
		})

		const payload = Buffer.from("protocol=https\nhost=github.com\n\n", "utf-8")
		const promise = runSshCommandOnSandbox({
			remoteHost: "h",
			remoteUser: "sandbox",
			authToken: "tok",
			remoteCommand: "git credential approve",
			stdin: payload,
			proxyCommand: "/tmp/proxy %h",
			_spawn: spawn as never,
		})

		queueMicrotask(() => child.emit("close", 0))
		await promise

		const opts = calls[0]?.options as { stdio: [string, string, string] }
		expect(opts.stdio[0]).toBe("pipe")
		expect(Buffer.concat(written).toString("utf-8")).toBe(payload.toString("utf-8"))
	})
})
