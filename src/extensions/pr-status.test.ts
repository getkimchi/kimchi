import type { ChildProcess } from "node:child_process"
import { spawn } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPrStatusWatcher, getPrStatusLine, type PrInfo, setPrStatusForTest } from "./pr-status.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>

function fakeChild(): ChildProcess & { emitStdout(data: string): void; emitClose(code: number): void } {
	const events = new Map<string, Set<(...args: unknown[]) => void>>()
	const child = {
		stdout: {
			on: (event: string, cb: (data: Buffer) => void) => {
				let set = events.get(event)
				if (!set) {
					set = new Set()
					events.set(event, set)
				}
				set.add(cb as (...args: unknown[]) => void)
			},
		},
		stderr: { on: vi.fn() },
		on: (event: string, cb: (...args: unknown[]) => void) => {
			let set = events.get(event)
			if (!set) {
				set = new Set()
				events.set(event, set)
			}
			set.add(cb)
		},
		emitStdout: (data: string) => {
			for (const cb of events.get("data") ?? []) (cb as (data: Buffer) => void)(Buffer.from(data))
		},
		emitClose: (code: number) => {
			for (const cb of events.get("close") ?? []) (cb as (code: number) => void)(code)
		},
	} as unknown as ChildProcess & { emitStdout(data: string): void; emitClose(code: number): void }
	return child
}

beforeEach(() => {
	setPrStatusForTest(undefined)
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
	mockSpawn.mockReset()
})

describe("createPrStatusWatcher", () => {
	it("fetches PR info on start and exposes it via getPrStatusLine", async () => {
		const child = fakeChild()
		mockSpawn.mockReturnValueOnce(child)

		const watcher = createPrStatusWatcher({ getCwd: () => "/repo" })
		const changes: (PrInfo | undefined)[] = []
		watcher.start(() => changes.push(getPrStatusLine()))

		child.emitStdout(JSON.stringify({ number: 42, url: "https://github.com/owner/repo/pull/42" }))
		child.emitClose(0)
		await vi.advanceTimersByTimeAsync(0)

		expect(getPrStatusLine()).toEqual({ number: 42, url: "https://github.com/owner/repo/pull/42" })
		expect(changes).toEqual([{ number: 42, url: "https://github.com/owner/repo/pull/42" }])

		watcher.stop()
	})

	it("clears PR info when gh exits non-zero", async () => {
		const child = fakeChild()
		mockSpawn.mockReturnValueOnce(child)

		const watcher = createPrStatusWatcher({ getCwd: () => "/repo" })
		watcher.start(() => {})

		child.emitStdout("no pull requests match your search")
		child.emitClose(1)
		await vi.advanceTimersByTimeAsync(0)

		expect(getPrStatusLine()).toBeUndefined()
		watcher.stop()
	})

	it("refreshes periodically", async () => {
		const children = [fakeChild(), fakeChild()]
		mockSpawn.mockReturnValueOnce(children[0]).mockReturnValueOnce(children[1])

		const watcher = createPrStatusWatcher({ getCwd: () => "/repo" })
		watcher.start(() => {})

		children[0].emitStdout(JSON.stringify({ number: 42, url: "https://github.com/owner/repo/pull/42" }))
		children[0].emitClose(0)
		await vi.advanceTimersByTimeAsync(0)
		expect(getPrStatusLine()?.number).toBe(42)

		await vi.advanceTimersByTimeAsync(30_000)

		children[1].emitStdout(JSON.stringify({ number: 43, url: "https://github.com/owner/repo/pull/43" }))
		children[1].emitClose(0)
		await vi.advanceTimersByTimeAsync(0)
		expect(getPrStatusLine()?.number).toBe(43)

		watcher.stop()
	})

	it("stops polling and clears state on stop", async () => {
		const child = fakeChild()
		mockSpawn.mockReturnValueOnce(child)

		const watcher = createPrStatusWatcher({ getCwd: () => "/repo" })
		watcher.start(() => {})

		child.emitStdout(JSON.stringify({ number: 42, url: "https://github.com/owner/repo/pull/42" }))
		child.emitClose(0)
		await vi.advanceTimersByTimeAsync(0)
		expect(getPrStatusLine()).toBeDefined()

		watcher.stop()
		expect(getPrStatusLine()).toBeUndefined()
		expect(mockSpawn).toHaveBeenCalledOnce()

		await vi.advanceTimersByTimeAsync(60_000)
		expect(mockSpawn).toHaveBeenCalledOnce()
	})
})
