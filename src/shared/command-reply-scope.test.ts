import { afterEach, describe, expect, it } from "vitest"
import { isInCommandReplyScope, resetCommandReplyScopesForTests, withCommandReplyScope } from "./command-reply-scope.js"

afterEach(() => {
	resetCommandReplyScopesForTests()
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

describe("command reply scope", () => {
	it("is in scope only while the run is pending", async () => {
		expect(isInCommandReplyScope("s-a")).toBe(false)
		const gate = deferred()
		const running = withCommandReplyScope("s-a", async () => {
			await gate.promise
			return "done"
		})
		expect(isInCommandReplyScope("s-a")).toBe(true)
		gate.resolve()
		await expect(running).resolves.toBe("done")
		expect(isInCommandReplyScope("s-a")).toBe(false)
	})

	it("keeps scopes per session", async () => {
		const gate = deferred()
		const running = withCommandReplyScope("s-a", () => gate.promise)
		expect(isInCommandReplyScope("s-a")).toBe(true)
		expect(isInCommandReplyScope("s-b")).toBe(false)
		gate.resolve()
		await running
	})

	it("stays in scope until the outer of two nested runs ends", async () => {
		const outerGate = deferred()
		const outer = withCommandReplyScope("s-a", async () => {
			await withCommandReplyScope("s-a", async () => {})
			expect(isInCommandReplyScope("s-a")).toBe(true)
			await outerGate.promise
		})
		await Promise.resolve()
		expect(isInCommandReplyScope("s-a")).toBe(true)
		outerGate.resolve()
		await outer
		expect(isInCommandReplyScope("s-a")).toBe(false)
	})

	it("leaves the scope when the run throws", async () => {
		const failure = new Error("handler failed")
		await expect(
			withCommandReplyScope("s-a", async () => {
				throw failure
			}),
		).rejects.toBe(failure)
		expect(isInCommandReplyScope("s-a")).toBe(false)
	})
})
