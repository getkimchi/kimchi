import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BRANCH_POLL_INTERVAL_MS, createBranchPoller } from "./ui-branch-poll.js"

describe("createBranchPoller", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("calls onChange when the branch changes", () => {
		let branch = "main"
		const refreshBranch = vi.fn((cb: (b: string | undefined) => void) => cb(branch))
		const onChange = vi.fn()

		const poller = createBranchPoller({ refreshBranch })
		poller.start(onChange)

		expect(refreshBranch).toHaveBeenCalledTimes(1)
		expect(onChange).not.toHaveBeenCalled()

		branch = "feature-x"
		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS)

		expect(refreshBranch).toHaveBeenCalledTimes(2)
		expect(onChange).toHaveBeenCalledTimes(1)
	})

	it("does not call onChange when the branch stays the same", () => {
		const refreshBranch = vi.fn((cb: (b: string | undefined) => void) => cb("main"))
		const onChange = vi.fn()

		const poller = createBranchPoller({ refreshBranch })
		poller.start(onChange)

		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS * 3)

		expect(refreshBranch).toHaveBeenCalledTimes(4)
		expect(onChange).not.toHaveBeenCalled()
	})

	it("does not call onChange when refreshBranch returns undefined", () => {
		const refreshBranch = vi.fn((cb: (b: string | undefined) => void) => cb(undefined))
		const onChange = vi.fn()

		const poller = createBranchPoller({ refreshBranch })
		poller.start(onChange)

		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS)

		expect(onChange).not.toHaveBeenCalled()
	})

	it("calls onChange on every subsequent change", () => {
		let branch = "main"
		const refreshBranch = vi.fn((cb: (b: string | undefined) => void) => cb(branch))
		const onChange = vi.fn()

		const poller = createBranchPoller({ refreshBranch })
		poller.start(onChange)

		branch = "a"
		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS)
		expect(onChange).toHaveBeenCalledTimes(1)

		branch = "b"
		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS)
		expect(onChange).toHaveBeenCalledTimes(2)

		branch = "c"
		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS)
		expect(onChange).toHaveBeenCalledTimes(3)
	})

	it("resets last known branch after stop()", () => {
		let branch = "main"
		const refreshBranch = vi.fn((cb: (b: string | undefined) => void) => cb(branch))
		const onChange = vi.fn()

		const poller = createBranchPoller({ refreshBranch })
		poller.start(onChange)

		poller.stop()

		branch = "feature-y"
		poller.start(onChange)

		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS)
		expect(onChange).not.toHaveBeenCalled()
	})

	it("clears timer on stop() so onChange is never fired again", () => {
		let branch = "main"
		const refreshBranch = vi.fn((cb: (b: string | undefined) => void) => cb(branch))
		const onChange = vi.fn()

		const poller = createBranchPoller({ refreshBranch })
		poller.start(onChange)
		poller.stop()

		branch = "feature-z"
		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS * 10)

		expect(onChange).not.toHaveBeenCalled()
	})

	it("clears previous timer when start() is called twice", () => {
		let branch = "main"
		const refreshBranch = vi.fn((cb: (b: string | undefined) => void) => cb(branch))
		const onChange = vi.fn()

		const poller = createBranchPoller({ refreshBranch })
		poller.start(onChange)

		branch = "feature-1"
		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS)
		expect(onChange).toHaveBeenCalledTimes(1)

		branch = "feature-2"
		poller.start(onChange)

		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS)
		expect(onChange).toHaveBeenCalledTimes(1)
	})

	it("accepts a custom interval", () => {
		let branch = "main"
		const refreshBranch = vi.fn((cb: (b: string | undefined) => void) => cb(branch))
		const onChange = vi.fn()

		const poller = createBranchPoller({ refreshBranch }, 100)
		poller.start(onChange)

		branch = "feature-fast"
		vi.advanceTimersByTime(99)
		expect(onChange).not.toHaveBeenCalled()

		vi.advanceTimersByTime(1)
		expect(onChange).toHaveBeenCalledTimes(1)
	})

	it("skips overlapping refreshes", () => {
		let calls = 0
		const refreshBranch = vi.fn((cb: (b: string | undefined) => void) => {
			calls++
			cb("main")
		})
		const onChange = vi.fn()

		const poller = createBranchPoller({ refreshBranch }, 100)
		poller.start(onChange)

		vi.advanceTimersByTime(50)
		expect(refreshBranch).toHaveBeenCalledTimes(1)

		vi.advanceTimersByTime(100)
		expect(refreshBranch).toHaveBeenCalledTimes(2)

		vi.advanceTimersByTime(100)
		expect(refreshBranch).toHaveBeenCalledTimes(3)
	})
})
