import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { maxIterationsExtension } from "./max-iterations.js"

type StubHandler = (evt: unknown, ctx: unknown) => unknown
type StubCtxShape = { shutdown: () => void }

function makeStubPi() {
	const handlers: Record<string, StubHandler[]> = {}
	return {
		on: vi.fn((event: string, handler: StubHandler) => {
			if (handlers[event] === undefined) handlers[event] = []
			handlers[event].push(handler)
		}),
		fireTurnEnd: (ctx: StubCtxShape) => {
			for (const h of handlers.turn_end ?? []) h({ type: "turn_end" }, ctx)
		},
	}
}

function makeStubCtx(overrides: Partial<StubCtxShape> = {}): StubCtxShape {
	return {
		shutdown: vi.fn(),
		...overrides,
	}
}

describe("maxIterationsExtension", () => {
	const exitMock = vi.fn()
	const originalExit = process.exit
	const originalStderrWrite = process.stderr.write.bind(process.stderr)

	beforeEach(() => {
		exitMock.mockReset()
		// Replace process.exit with a no-op so tests don't terminate the worker.
		;(process as unknown as { exit: (code?: number) => void }).exit = exitMock
		// Silence the "max-iterations: hit limit ..." line during tests.
		process.stderr.write = (() => true) as typeof process.stderr.write
	})

	afterEach(() => {
		;(process as unknown as { exit: typeof originalExit }).exit = originalExit
		process.stderr.write = originalStderrWrite
	})

	it("throws when maxIterations is 0", () => {
		expect(() => maxIterationsExtension({ maxIterations: 0 })).toThrow(/maxIterations must be a positive integer/)
	})

	it("throws when maxIterations is -1", () => {
		expect(() => maxIterationsExtension({ maxIterations: -1 })).toThrow(/maxIterations must be a positive integer/)
	})

	it("throws when maxIterations is a non-integer (1.5)", () => {
		expect(() => maxIterationsExtension({ maxIterations: 1.5 })).toThrow(/maxIterations must be a positive integer/)
	})

	it("throws when maxIterations is NaN", () => {
		expect(() => maxIterationsExtension({ maxIterations: Number.NaN })).toThrow(
			/maxIterations must be a positive integer/,
		)
	})

	it("registers exactly one turn_end handler when installed", () => {
		const pi = makeStubPi()
		maxIterationsExtension({ maxIterations: 3 })(pi as unknown as ExtensionAPI)

		const turnEndCalls = pi.on.mock.calls.filter((c) => c[0] === "turn_end")
		expect(turnEndCalls).toHaveLength(1)
	})

	it("does not call ctx.shutdown before the limit is reached", () => {
		const pi = makeStubPi()
		const ctx = makeStubCtx()
		maxIterationsExtension({ maxIterations: 3 })(pi as unknown as ExtensionAPI)

		pi.fireTurnEnd(ctx)
		pi.fireTurnEnd(ctx)

		expect(ctx.shutdown).not.toHaveBeenCalled()
	})

	it("calls ctx.shutdown exactly once after N turn_end events (N=3)", async () => {
		const pi = makeStubPi()
		const ctx = makeStubCtx({ shutdown: vi.fn().mockResolvedValue(undefined) })
		maxIterationsExtension({ maxIterations: 3 })(pi as unknown as ExtensionAPI)

		pi.fireTurnEnd(ctx)
		pi.fireTurnEnd(ctx)
		pi.fireTurnEnd(ctx)

		await Promise.resolve()
		expect(ctx.shutdown).toHaveBeenCalledTimes(1)
	})

	it("calls process.exit(0) by default (because ctx.shutdown is a no-op in pi print mode)", () => {
		const pi = makeStubPi()
		const ctx = makeStubCtx()
		maxIterationsExtension({ maxIterations: 1 })(pi as unknown as ExtensionAPI)

		pi.fireTurnEnd(ctx)

		expect(exitMock).toHaveBeenCalledWith(0)
	})

	it("does NOT call process.exit when a custom onLimit is provided", () => {
		const pi = makeStubPi()
		const ctx = makeStubCtx()
		const onLimit = vi.fn()
		maxIterationsExtension({ maxIterations: 1, onLimit })(pi as unknown as ExtensionAPI)

		pi.fireTurnEnd(ctx)

		expect(onLimit).toHaveBeenCalledTimes(1)
		expect(exitMock).not.toHaveBeenCalled()
	})

	it("subsequent turn_end events after limit do not trigger again (triggered guard)", async () => {
		const pi = makeStubPi()
		const ctx = makeStubCtx({ shutdown: vi.fn().mockResolvedValue(undefined) })
		maxIterationsExtension({ maxIterations: 2 })(pi as unknown as ExtensionAPI)

		pi.fireTurnEnd(ctx)
		pi.fireTurnEnd(ctx)
		pi.fireTurnEnd(ctx)
		pi.fireTurnEnd(ctx)

		await Promise.resolve()
		expect(ctx.shutdown).toHaveBeenCalledTimes(1)
	})

	it("single iteration limit (=1) fires on the very first turn_end", async () => {
		const pi = makeStubPi()
		const ctx = makeStubCtx({ shutdown: vi.fn().mockResolvedValue(undefined) })
		maxIterationsExtension({ maxIterations: 1 })(pi as unknown as ExtensionAPI)

		pi.fireTurnEnd(ctx)

		await Promise.resolve()
		expect(ctx.shutdown).toHaveBeenCalledTimes(1)
	})

	it("uses custom onLimit callback instead of ctx.shutdown when provided", () => {
		const pi = makeStubPi()
		const ctx = makeStubCtx()
		const onLimit = vi.fn()
		maxIterationsExtension({ maxIterations: 1, onLimit })(pi as unknown as ExtensionAPI)

		pi.fireTurnEnd(ctx)

		expect(onLimit).toHaveBeenCalledTimes(1)
		expect(ctx.shutdown).not.toHaveBeenCalled()
	})

	it("onLimit is not called more than once even when additional turn_end events fire", () => {
		const pi = makeStubPi()
		const ctx = makeStubCtx()
		const onLimit = vi.fn()
		maxIterationsExtension({ maxIterations: 1, onLimit })(pi as unknown as ExtensionAPI)

		pi.fireTurnEnd(ctx)
		pi.fireTurnEnd(ctx)
		pi.fireTurnEnd(ctx)

		expect(onLimit).toHaveBeenCalledTimes(1)
	})

	it("does not throw synchronously when ctx.shutdown rejects", async () => {
		const pi = makeStubPi()
		const ctx = makeStubCtx({
			shutdown: vi.fn().mockReturnValue(Promise.reject(new Error("shutdown failed"))),
		})
		maxIterationsExtension({ maxIterations: 1 })(pi as unknown as ExtensionAPI)

		expect(() => pi.fireTurnEnd(ctx)).not.toThrow()

		await Promise.resolve()
	})
})
