import { describe, expect, it } from "vitest"
import { isAgentWorker, runAsAgentWorker } from "../agent-worker-context.js"
import { PromptQueue } from "./prompt-queue.js"

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
	let resolve!: (value: T) => void
	let reject!: (err: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

/** Flush pending microtasks so queue pumps and settled promises propagate. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe("PromptQueue", () => {
	it("runs entries serially in FIFO order", async () => {
		const queue = new PromptQueue()
		const order: string[] = []
		const first = deferred<string>()
		const second = deferred<string>()

		const firstEnqueued = queue.enqueue(() => {
			order.push("first:start")
			return first.promise
		})
		const secondEnqueued = queue.enqueue(() => {
			order.push("second:start")
			return second.promise
		})

		await flush()
		expect(order).toEqual(["first:start"])
		expect(queue.depth).toBe(1)

		first.resolve("one")
		await flush()
		expect(order).toEqual(["first:start", "second:start"])

		second.resolve("two")
		await flush()
		await expect(firstEnqueued).resolves.toBe("one")
		await expect(secondEnqueued).resolves.toBe("two")
		expect(queue.depth).toBe(0)
	})

	it("drops an entry whose signal aborts while waiting — its task never runs", async () => {
		const queue = new PromptQueue()
		const blocker = deferred<void>()
		const controller = new AbortController()
		let droppedTaskRan = false

		const first = queue.enqueue(() => blocker.promise)
		const dropped = queue.enqueue(() => {
			droppedTaskRan = true
			return Promise.resolve("dropped")
		}, controller.signal)
		await flush()
		expect(queue.depth).toBe(1)

		controller.abort()
		await expect(dropped).rejects.toThrow()
		expect(droppedTaskRan).toBe(false)
		expect(queue.depth).toBe(0)

		blocker.resolve()
		await expect(first).resolves.toBeUndefined()
	})

	it("rejects immediately for an already-aborted signal without running the task", async () => {
		const queue = new PromptQueue()
		const controller = new AbortController()
		controller.abort()
		let ran = false
		await expect(
			queue.enqueue(() => {
				ran = true
				return Promise.resolve()
			}, controller.signal),
		).rejects.toThrow()
		expect(ran).toBe(false)
	})

	it("an orphaned running prompt cannot hold the queue when its signal aborts", async () => {
		const queue = new PromptQueue()
		const controller = new AbortController()
		// Simulates pi's single dialog slot silently replacing a prompt: the
		// task promise NEVER settles.
		const orphaned = queue.enqueue(() => new Promise<string>(() => {}), controller.signal)
		await flush()

		controller.abort()
		await expect(orphaned).rejects.toThrow()

		// The next entry runs even though the orphaned task never settled.
		const next = await queue.enqueue(() => Promise.resolve("next"))
		expect(next).toBe("next")
	})

	it("ignores the late settle of a task orphaned by an abort", async () => {
		const queue = new PromptQueue()
		const controller = new AbortController()
		const task = deferred<string>()
		const enqueued = queue.enqueue(() => task.promise, controller.signal)
		await flush()
		controller.abort()
		await expect(enqueued).rejects.toThrow()

		// Late resolution must not crash, double-settle, or wedge the queue.
		task.resolve("late")
		await flush()
		await expect(queue.enqueue(() => Promise.resolve("after"))).resolves.toBe("after")
	})

	it("propagates task rejections and keeps the queue moving", async () => {
		const queue = new PromptQueue()
		const failure = new Error("boom")
		await expect(queue.enqueue(() => Promise.reject(failure))).rejects.toBe(failure)
		await expect(queue.enqueue(() => Promise.resolve("ok"))).resolves.toBe("ok")
	})

	it("propagates synchronous task throws as rejections", async () => {
		const queue = new PromptQueue()
		const failure = new Error("sync")
		await expect(
			queue.enqueue(() => {
				throw failure
			}),
		).rejects.toBe(failure)
	})

	it("runs each task in the async context captured at enqueue", async () => {
		const queue = new PromptQueue()
		const first = deferred<void>()
		const second = deferred<void>()
		const secondStarted = deferred<void>()
		const seenWorker: boolean[] = []

		const firstEnqueued = queue.enqueue(() => first.promise)
		const secondEnqueued = runAsAgentWorker(() =>
			queue.enqueue(async () => {
				seenWorker.push(isAgentWorker())
				secondStarted.resolve()
				await second.promise
			}),
		)
		first.resolve()
		await secondStarted.promise
		// Enqueued while the second task still runs. Its pump starts from the
		// second task's completion callback, under the second task's old context.
		const thirdEnqueued = queue.enqueue(async () => {
			seenWorker.push(isAgentWorker())
		})
		second.resolve()

		await Promise.all([firstEnqueued, secondEnqueued, thirdEnqueued])
		expect(seenWorker).toEqual([true, false])
	})

	it("entries without a signal run normally", async () => {
		const queue = new PromptQueue()
		await expect(queue.enqueue(() => Promise.resolve(42))).resolves.toBe(42)
	})
})
