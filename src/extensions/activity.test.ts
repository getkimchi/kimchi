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

describe("ActivityBus – sandbox detection", () => {
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
		vi.stubEnv("KIMCHI_SANDBOX", "1")
		const bus = new ActivityBus()
		await bus.start("session-guard-present")
		expect(bus.isActive()).toBe(true)
		await bus.stop()
	})
})

describe("ActivityBus – send and broadcast", () => {
	let bus: ActivityBus | null = null
	let client: net.Socket | null = null

	afterEach(() => {
		vi.unstubAllEnvs()
		try {
			client?.destroy()
		} catch {
			/* best-effort */
		}
		client = null
		if (bus) {
			bus.stop().catch(() => {
				/* best-effort */
			})
			bus = null
		}
	})

	it("broadcasts JSON events as NDJSON lines to connected clients", async () => {
		vi.stubEnv("KIMCHI_SANDBOX", "1")
		bus = new ActivityBus()
		await bus.start("sess-broadcast")

		const { received, client: c, connected } = connectClient("/tmp/kimchi/sess-broadcast.sock")
		client = c
		await connected

		bus.send({ type: "agent_start" })
		bus.send({ type: "agent_end" })
		await new Promise<void>((resolve) => setTimeout(resolve, 50))

		expect(received).toContain(JSON.stringify({ type: "agent_start" }))
		expect(received).toContain(JSON.stringify({ type: "agent_end" }))
	})

	it("does not throw when no clients are connected", async () => {
		vi.stubEnv("KIMCHI_SANDBOX", "1")
		bus = new ActivityBus()
		const b = bus
		await b.start("sess-noconn")
		expect(() => b.send({ type: "agent_start" })).not.toThrow()
	})

	it("does not throw when bus is inactive (SANDBOX_ID absent)", () => {
		bus = new ActivityBus()
		const b = bus
		expect(() => b.send({ type: "agent_start" })).not.toThrow()
	})
})

describe("ActivityBus – lifecycle", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("cleans up socket file on stop()", async () => {
		vi.stubEnv("KIMCHI_SANDBOX", "1")
		const bus = new ActivityBus()
		await bus.start("sess-cleanup")
		expect(existsSync("/tmp/kimchi/sess-cleanup.sock")).toBe(true)
		await bus.stop()
		expect(existsSync("/tmp/kimchi/sess-cleanup.sock")).toBe(false)
	})

	it("sends session_shutdown before closing on stop()", async () => {
		vi.stubEnv("KIMCHI_SANDBOX", "1")
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
	let bus: ActivityBus | null = null
	let client: net.Socket | null = null

	afterEach(() => {
		vi.unstubAllEnvs()
		try {
			client?.destroy()
		} catch {
			/* best-effort */
		}
		client = null
		if (bus) {
			bus.stop().catch(() => {
				/* best-effort */
			})
			bus = null
		}
	})

	it("does not crash on malformed or valid incoming data", async () => {
		vi.stubEnv("KIMCHI_SANDBOX", "1")
		bus = new ActivityBus()
		await bus.start("sess-incoming")

		client = net.createConnection("/tmp/kimchi/sess-incoming.sock")
		const c = client
		await new Promise<void>((resolve) => c.once("connect", resolve))

		client.write('{"type":"hibernate_warning"}\n')
		client.write("not-json\n")
		await new Promise<void>((resolve) => setTimeout(resolve, 50))

		expect(bus.isActive()).toBe(true)
	})
})
