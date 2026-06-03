import { describe, expect, it } from "vitest"
import { waitForWorkspaceReady } from "./readiness.js"

describe("waitForWorkspaceReady", () => {
	type WSEvent = "open" | "close" | "error"
	class FakeWS {
		readonly url: string
		readonly opts: { headers?: Record<string, string> } | undefined
		readonly listeners = new Map<WSEvent, Array<(e: unknown) => void>>()
		closed = false
		constructor(url: string, opts?: { headers?: Record<string, string> }) {
			this.url = url
			this.opts = opts
		}
		addEventListener(type: WSEvent, cb: (e: unknown) => void) {
			const list = this.listeners.get(type) ?? []
			list.push(cb)
			this.listeners.set(type, list)
		}
		removeEventListener() {
			/* unused */
		}
		close() {
			this.closed = true
		}
		fire(type: WSEvent, payload: unknown = {}) {
			for (const cb of this.listeners.get(type) ?? []) cb(payload)
		}
	}

	function wsFactory() {
		const created: FakeWS[] = []
		const ctor = function (this: unknown, url: string, opts?: { headers?: Record<string, string> }) {
			const ws = new FakeWS(url, opts)
			created.push(ws)
			return ws
		} as unknown as new (
			url: string,
			opts?: { headers?: Record<string, string> },
		) => FakeWS
		return { created, ctor }
	}

	it("resolves on the first probe that opens", async () => {
		const { created, ctor } = wsFactory()

		const promise = waitForWorkspaceReady({
			wsUrl: "wss://h.example.com/",
			connectToken: "tok-1",
			pollIntervalMs: 1,
			probeTimeoutMs: 1000,
			_WebSocket: ctor,
		})

		await Promise.resolve()
		await Promise.resolve()
		expect(created).toHaveLength(1)
		expect(created[0].url).toBe("wss://h.example.com//connect")
		expect(created[0].opts?.headers).toEqual({ Authorization: "Bearer tok-1" })

		created[0].fire("open")
		await expect(promise).resolves.toBeUndefined()
		expect(created[0].closed).toBe(true)
	})

	it("retries when the first probe closes with a non-101", async () => {
		const { created, ctor } = wsFactory()

		const promise = waitForWorkspaceReady({
			wsUrl: "wss://h.example.com/",
			connectToken: "tok",
			pollIntervalMs: 1,
			probeTimeoutMs: 1000,
			_WebSocket: ctor,
		})

		await Promise.resolve()
		await Promise.resolve()
		created[0].fire("close", { code: 1002, reason: "not yet" })

		await new Promise((r) => setTimeout(r, 10))
		expect(created.length).toBeGreaterThanOrEqual(2)
		created[1].fire("open")

		await expect(promise).resolves.toBeUndefined()
	})

	it("fires onTick for each probe with lastError on failure", async () => {
		const { created, ctor } = wsFactory()
		const ticks: Array<{ elapsedMs: number; lastError?: string }> = []

		const promise = waitForWorkspaceReady({
			wsUrl: "wss://h.example.com/",
			connectToken: "tok",
			pollIntervalMs: 1,
			probeTimeoutMs: 1000,
			onTick: (t) => ticks.push(t),
			_WebSocket: ctor,
		})

		await Promise.resolve()
		await Promise.resolve()
		created[0].fire("close", { code: 1002 })
		await new Promise((r) => setTimeout(r, 10))
		created[1].fire("open")
		await promise

		expect(ticks).toHaveLength(2)
		expect(ticks[0].lastError).toMatch(/code=1002/)
		expect(ticks[1].lastError).toBeUndefined()
	})

	it("rejects on overall timeout with the last probe error in the message", async () => {
		const { created, ctor } = wsFactory()

		const promise = waitForWorkspaceReady({
			wsUrl: "wss://h.example.com/",
			connectToken: "tok",
			pollIntervalMs: 5,
			probeTimeoutMs: 2,
			timeoutMs: 30,
			_WebSocket: ctor,
		})

		const loop = setInterval(() => {
			const latest = created[created.length - 1]
			if (latest && !latest.closed) latest.fire("close", { code: 1002 })
		}, 1)

		await expect(promise).rejects.toThrow(/code=1002/)
		clearInterval(loop)
	})

	it("rejects when the abort signal fires", async () => {
		const { ctor } = wsFactory()
		const ctrl = new AbortController()

		const promise = waitForWorkspaceReady({
			wsUrl: "wss://h.example.com/",
			connectToken: "tok",
			pollIntervalMs: 60_000,
			probeTimeoutMs: 60_000,
			signal: ctrl.signal,
			_WebSocket: ctor,
		})

		setTimeout(() => ctrl.abort(), 5)
		await expect(promise).rejects.toThrow(/[Aa]borted/)
	})

	it("throws when no WebSocket implementation is available", async () => {
		await expect(
			waitForWorkspaceReady({
				wsUrl: "wss://h.example.com/",
				connectToken: "tok",
				// biome-ignore lint/suspicious/noExplicitAny: simulate missing WebSocket
				_WebSocket: undefined as any,
			}),
		).rejects.toThrow(/WebSocket is not available/)
	})
})
