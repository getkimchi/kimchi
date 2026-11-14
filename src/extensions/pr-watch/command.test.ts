import { describe, expect, it, vi } from "vitest"
import { prWatchCommandArgs, runPRWatchCommand } from "./command.js"
import type { PRWatchState } from "./types.js"
import type { PRWatcher } from "./watcher.js"

vi.mock("./settings.js", () => ({ writePRWatchPreference: vi.fn() }))

const URL7 = "https://github.com/owner/repo/pull/7"
const state: PRWatchState = { targets: [], message: null }

function fakeWatcher(watching = false) {
	return {
		snapshot: { targets: watching ? [{ enabled: true }] : [], message: null },
		start: vi.fn(async () => state),
		pause: vi.fn(() => state),
		stop: vi.fn(() => state),
		refresh: vi.fn(async () => state),
	}
}

describe("/pr-watch", () => {
	it.each([
		["", "start", { autoFix: true, instructions: "" }],
		["reviews", "start", { autoFix: true, mode: "reviews" }],
		["only fix lint errors", "start", { autoFix: true, instructions: "only fix lint errors" }],
		[`${URL7} only lint`, "start", { autoFix: true, instructions: `${URL7} only lint` }],
		["status", "refresh", undefined],
		["stop", "stop", undefined],
	])("runs %j as %s", async (args, method, grant) => {
		const watcher = fakeWatcher()
		await runPRWatchCommand(watcher as unknown as PRWatcher, args)
		expect(watcher[method as "start"]).toHaveBeenCalledWith(...(grant ? [grant] : []))
	})

	it("pauses what is watched and otherwise starts read-only", async () => {
		const idle = fakeWatcher()
		await runPRWatchCommand(idle as unknown as PRWatcher, "watch")
		expect(idle.start).toHaveBeenCalledWith({ autoFix: false })
		const watching = fakeWatcher(true)
		await runPRWatchCommand(watching as unknown as PRWatcher, "pause")
		expect(watching.pause).toHaveBeenCalledOnce()
	})

	it.each([
		[
			"mine",
			"Watch my open GitHub PRs and fix CI failures locally using pr_watch with allMine=true, provider=github, mode=ci.",
		],
		[
			"mine gitlab git.company.test",
			'Watch my open GitLab MRs and fix CI failures locally using pr_watch with allMine=true, provider=gitlab, mode=ci and host="git.company.test".',
		],
		[
			`${URL7}  ${URL7}/`,
			`Watch these PRs and fix CI failures locally using pr_watch with mode=ci: ${JSON.stringify([URL7, `${URL7}/`])}`,
		],
	])("hands %j to the model", async (args, prompt) => {
		expect(await runPRWatchCommand(fakeWatcher() as unknown as PRWatcher, args)).toEqual({ prompt })
	})

	it("refuses a mistyped subcommand and overlong instructions without granting fixes", async () => {
		const watcher = fakeWatcher()
		await expect(runPRWatchCommand(watcher as unknown as PRWatcher, "disabel")).rejects.toThrow(
			'Unknown /pr-watch command "disabel"',
		)
		await expect(runPRWatchCommand(watcher as unknown as PRWatcher, "x".repeat(4001))).rejects.toThrow("4000")
		expect(watcher.start).not.toHaveBeenCalled()
	})

	it.each([
		["/pr-watch", ""],
		["/pr-watch stop", " stop"],
		["/pr-watch\nstatus", "\nstatus"],
		["/pr-watchers", undefined],
		["please /pr-watch", undefined],
	])("reads %j as a /pr-watch prompt: %j", (text, args) => {
		expect(prWatchCommandArgs(text)).toBe(args)
	})
})
