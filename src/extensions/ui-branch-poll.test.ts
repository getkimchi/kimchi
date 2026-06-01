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
		const getGitBranch = vi.fn(() => branch)
		const onChange = vi.fn()

		const poller = createBranchPoller({ getGitBranch })
		poller.start(onChange)

		// Initial read happens immediately in start()
		expect(getGitBranch).toHaveBeenCalledTimes(1)
		expect(onChange).not.toHaveBeenCalled()

		branch = "feature-x"
		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS)

		expect(getGitBranch).toHaveBeenCalledTimes(2)
		expect(onChange).toHaveBeenCalledTimes(1)
	})

	it("does not call onChange when the branch stays the same", () => {
		const getGitBranch = vi.fn(() => "main")
		const onChange = vi.fn()

		const poller = createBranchPoller({ getGitBranch })
		poller.start(onChange)

		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS * 3)

		expect(getGitBranch).toHaveBeenCalledTimes(4)
		expect(onChange).not.toHaveBeenCalled()
	})

	it("does not call onChange when getGitBranch returns undefined", () => {
		const getGitBranch = vi.fn(() => undefined)
		const onChange = vi.fn()

		const poller = createBranchPoller({ getGitBranch })
		poller.start(onChange)

		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS)

		expect(onChange).not.toHaveBeenCalled()
	})

	it("calls onChange on every subsequent change", () => {
		let branch = "main"
		const getGitBranch = vi.fn(() => branch)
		const onChange = vi.fn()

		const poller = createBranchPoller({ getGitBranch })
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
		const getGitBranch = vi.fn(() => branch)
		const onChange = vi.fn()

		const poller = createBranchPoller({ getGitBranch })
		poller.start(onChange)

		poller.stop()

		// Restarting should re-establish the baseline branch, so a poll
		// that returns the same "new" branch must not trigger onChange.
		branch = "feature-y"
		poller.start(onChange)

		// After restart, lastKnownBranch is "feature-y", so another poll
		// with the same value should not fire.
		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS)
		expect(onChange).not.toHaveBeenCalled()
	})

	it("clears timer on stop() so onChange is never fired again", () => {
		let branch = "main"
		const getGitBranch = vi.fn(() => branch)
		const onChange = vi.fn()

		const poller = createBranchPoller({ getGitBranch })
		poller.start(onChange)
		poller.stop()

		branch = "feature-z"
		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS * 10)

		expect(onChange).not.toHaveBeenCalled()
	})

	it("clears previous timer when start() is called twice", () => {
		let branch = "main"
		const getGitBranch = vi.fn(() => branch)
		const onChange = vi.fn()

		const poller = createBranchPoller({ getGitBranch })
		poller.start(onChange)

		// First timer would fire here
		branch = "feature-1"
		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS)
		expect(onChange).toHaveBeenCalledTimes(1)

		// Restarting should reset baseline to current branch.
		branch = "feature-2"
		poller.start(onChange)

		// A single interval passes — baseline was just set to "feature-2",
		// so no change should be detected yet.
		vi.advanceTimersByTime(BRANCH_POLL_INTERVAL_MS)
		expect(onChange).toHaveBeenCalledTimes(1)
	})

	it("accepts a custom interval", () => {
		let branch = "main"
		const getGitBranch = vi.fn(() => branch)
		const onChange = vi.fn()

		const poller = createBranchPoller({ getGitBranch }, 100)
		poller.start(onChange)

		branch = "feature-fast"
		vi.advanceTimersByTime(99)
		expect(onChange).not.toHaveBeenCalled()

		vi.advanceTimersByTime(1)
		expect(onChange).toHaveBeenCalledTimes(1)
	})
})
