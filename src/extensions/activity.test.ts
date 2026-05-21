import { existsSync } from "node:fs"
import net from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ActivityBus } from "./activity.js"

/** Connect a client to the bus socket and collect received NDJSON lines. */
function connectClient(sockPath: string): { received: string[]; client: net.Socket; connected: Promise<void> } {
	const received: string[] = []
	const client = net.createConnection(sockPath)
	const connected = new Promise<void>((resolve) => client.once("connect", resolve))
	client.on("data", (chunk) => {
		received.push(...chunk.toString().split("\n").filter(Boolean))
	})
	return { received, client, connected }
}

describe("ActivityBus – SANDBOX_ID guard", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("does not start a server when SANDBOX_ID is absent", async () => {
		const bus = new ActivityBus()
		await bus.start("session-guard-absent")
		expect(bus.isActive()).toBe(false)
		await bus.stop()
	})

	it("starts a server when SANDBOX_ID is present", async () => {
		vi.stubEnv("SANDBOX_ID", "sb-guard")
		const bus = new ActivityBus()
		await bus.start("session-guard-present")
		expect(bus.isActive()).toBe(true)
		await bus.stop()
	})
})

describe("ActivityBus – send and broadcast", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("broadcasts JSON events as NDJSON lines to connected clients", async () => {
		vi.stubEnv("SANDBOX_ID", "sb-broadcast")
		const bus = new ActivityBus()
		await bus.start("sess-broadcast")

		const { received, client, connected } = connectClient("/tmp/kimchi/sess-broadcast.sock")
		await connected

		bus.send({ type: "agent_start" })
		bus.send({ type: "agent_end" })
		await new Promise<void>((resolve) => setTimeout(resolve, 50))

		expect(received).toContain(JSON.stringify({ type: "agent_start" }))
		expect(received).toContain(JSON.stringify({ type: "agent_end" }))

		client.destroy()
		await bus.stop()
	})

	it("does not throw when no clients are connected", async () => {
		vi.stubEnv("SANDBOX_ID", "sb-noconn")
		const bus = new ActivityBus()
		await bus.start("sess-noconn")
		expect(() => bus.send({ type: "agent_start" })).not.toThrow()
		await bus.stop()
	})

	it("does not throw when bus is inactive (SANDBOX_ID absent)", () => {
		const bus = new ActivityBus()
		expect(() => bus.send({ type: "agent_start" })).not.toThrow()
	})
})

describe("ActivityBus – lifecycle", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("cleans up socket file on stop()", async () => {
		vi.stubEnv("SANDBOX_ID", "sb-cleanup")
		const bus = new ActivityBus()
		await bus.start("sess-cleanup")
		expect(existsSync("/tmp/kimchi/sess-cleanup.sock")).toBe(true)
		await bus.stop()
		expect(existsSync("/tmp/kimchi/sess-cleanup.sock")).toBe(false)
	})

	it("sends session_shutdown before closing on stop()", async () => {
		vi.stubEnv("SANDBOX_ID", "sb-shutdownmsg")
		const bus = new ActivityBus()
		await bus.start("sess-shutdown-msg")

		const { received, client, connected } = connectClient("/tmp/kimchi/sess-shutdown-msg.sock")
		await connected

		await bus.stop()
		await new Promise<void>((resolve) => setTimeout(resolve, 50))

		expect(received).toContain(JSON.stringify({ type: "session_shutdown" }))
		client.destroy()
	})

	it("stop() is a no-op when bus was never started", async () => {
		const bus = new ActivityBus()
		await expect(bus.stop()).resolves.toBeUndefined()
	})
})

describe("ActivityBus – incoming NDJSON no-op", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("does not crash on malformed or valid incoming data", async () => {
		vi.stubEnv("SANDBOX_ID", "sb-incoming")
		const bus = new ActivityBus()
		await bus.start("sess-incoming")

		const client = net.createConnection("/tmp/kimchi/sess-incoming.sock")
		await new Promise<void>((resolve) => client.once("connect", resolve))

		client.write('{"type":"hibernate_warning"}\n')
		client.write("not-json\n")
		await new Promise<void>((resolve) => setTimeout(resolve, 50))

		expect(bus.isActive()).toBe(true)
		client.destroy()
		await bus.stop()
	})
})
