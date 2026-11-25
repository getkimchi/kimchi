import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	configureReviewPrintStream,
	emitReviewAgentSettled,
	flushReviewPrintEvents,
	type ReviewPrintTermination,
	type ReviewPrintTerminationOptions,
	startReviewPrintTermination,
} from "./stream.js"

const rawChunks: string[] = []
const terminations: ReviewPrintTermination[] = []
const addedSignalListeners: NodeJS.SignalsListener[] = []
let previousExitCode: typeof process.exitCode

function signalListeners(): NodeJS.SignalsListener[] {
	return process.rawListeners("SIGTERM") as NodeJS.SignalsListener[]
}

function startTermination(options: Partial<ReviewPrintTerminationOptions> = {}): ReviewPrintTermination {
	const termination = startReviewPrintTermination({
		deadlineMs: Date.now(),
		graceMs: 20,
		exitMarginMs: 5,
		abort: vi.fn(),
		...options,
	})
	terminations.push(termination)
	return termination
}

function settledEvents(): Array<{ type: string; aborted: boolean }> {
	return rawChunks
		.join("")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; aborted: boolean })
		.filter((event) => event.type === "agent_settled")
}

beforeEach(async () => {
	previousExitCode = process.exitCode
	process.exitCode = undefined
	vi.useFakeTimers()
	vi.setSystemTime(new Date("2026-11-25T12:00:00Z"))
	rawChunks.length = 0
	vi.spyOn(process.stdout, "write").mockImplementation(((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	) => {
		rawChunks.push(String(chunk))
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback
		done?.()
		return true
	}) as typeof process.stdout.write)
	await configureReviewPrintStream(true)
})

afterEach(async () => {
	for (const termination of terminations.splice(0)) await termination.finish()
	for (const listener of addedSignalListeners.splice(0)) process.off("SIGTERM", listener)
	await configureReviewPrintStream(false)
	process.exitCode = previousExitCode
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe("review print raw output", () => {
	it("emits agent_settled once through the print host queue", async () => {
		emitReviewAgentSettled()
		emitReviewAgentSettled()
		await flushReviewPrintEvents()
		expect(settledEvents()).toEqual([{ type: "agent_settled", aborted: false }])
	})
})

describe("review print termination", () => {
	it("aborts on SIGTERM without exiting and settles exactly once", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit)
		const abort = vi.fn()
		const previous = signalListeners()
		const termination = startTermination({ abort })
		const terminate = signalListeners().find((listener) => !previous.includes(listener))
		if (!terminate) throw new Error("Missing scoped SIGTERM listener")

		// Deliver the event directly rather than sending a real signal to Vitest.
		terminate("SIGTERM")
		expect(abort).toHaveBeenCalledTimes(1)
		expect(termination.signal.aborted).toBe(true)
		expect(exit).not.toHaveBeenCalled()
		await termination.finish()
		await termination.finish()
		expect(exit).not.toHaveBeenCalled()
		expect(process.exitCode).toBe(143)
		expect(settledEvents()).toEqual([{ type: "agent_settled", aborted: false }])
	})

	it("uses exit 143 when the watchdog expires before finish", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit)
		const abort = vi.fn()
		const termination = startTermination({ abort })
		await vi.advanceTimersByTimeAsync(16)
		expect(abort).toHaveBeenCalledTimes(1)
		expect(termination.signal.aborted).toBe(true)
		expect(process.exitCode).toBe(143)
		expect(exit).toHaveBeenCalledExactlyOnceWith(143)
		await termination.finish()
		expect(settledEvents()).toEqual([{ type: "agent_settled", aborted: false }])
	})

	it("cancels the watchdog and never exits after finish", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit)
		const termination = startTermination()
		await termination.finish()
		await vi.advanceTimersByTimeAsync(100)
		expect(exit).not.toHaveBeenCalled()
		expect(process.exitCode).toBeUndefined()
		expect(settledEvents()).toEqual([{ type: "agent_settled", aborted: false }])
	})

	it("restores every original listener, including the exact once wrapper", async () => {
		const persistent = vi.fn()
		const once = vi.fn()
		process.on("SIGTERM", persistent)
		process.once("SIGTERM", once)
		addedSignalListeners.push(persistent, once)
		const original = signalListeners()
		const originalOnce = original.find(
			(listener) => (listener as NodeJS.SignalsListener & { listener?: unknown }).listener === once,
		)
		if (!originalOnce) throw new Error("Missing original once wrapper")

		const termination = startTermination()
		await termination.finish()
		const restored = signalListeners()
		expect(restored).toEqual(original)
		const restoredOnce = restored.find(
			(listener) => (listener as NodeJS.SignalsListener & { listener?: unknown }).listener === once,
		)
		expect(restoredOnce).toBe(originalOnce)

		restoredOnce?.call(process, "SIGTERM")
		restoredOnce?.call(process, "SIGTERM")
		expect(once).toHaveBeenCalledTimes(1)
		expect(signalListeners()).not.toContain(restoredOnce)
	})

	it("does not duplicate original callbacks re-registered during the scope", async () => {
		const persistent = vi.fn()
		const once = vi.fn()
		process.on("SIGTERM", persistent)
		process.once("SIGTERM", once)
		addedSignalListeners.push(persistent, once)
		const originalOnce = signalListeners().find(
			(listener) => (listener as NodeJS.SignalsListener & { listener?: unknown }).listener === once,
		)
		if (!originalOnce) throw new Error("Missing original once wrapper")

		const termination = startTermination()
		process.on("SIGTERM", persistent)
		process.once("SIGTERM", once)
		const readdedOnce = signalListeners().find(
			(listener) => (listener as NodeJS.SignalsListener & { listener?: unknown }).listener === once,
		)
		if (!readdedOnce) throw new Error("Missing re-registered once wrapper")
		expect(readdedOnce).not.toBe(originalOnce)
		await termination.finish()

		const restored = signalListeners()
		expect(
			restored.filter(
				(listener) =>
					((listener as NodeJS.SignalsListener & { listener?: unknown }).listener ?? listener) === persistent,
			),
		).toHaveLength(1)
		expect(
			restored.filter(
				(listener) => ((listener as NodeJS.SignalsListener & { listener?: unknown }).listener ?? listener) === once,
			),
		).toEqual([readdedOnce])
		readdedOnce.call(process, "SIGTERM")
		readdedOnce.call(process, "SIGTERM")
		expect(once).toHaveBeenCalledTimes(1)
	})
})
