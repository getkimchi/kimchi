import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, Key, test } from "@microsoft/tui-test"
import { poll } from "@microsoft/tui-test/lib/utils/poll.js"
import { viewText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import {
	createReviewInterruptionFixture,
	git,
	type ReviewInterruptionFixture,
	reviewInterruptionResponseScript,
	reviewResponseScripts,
	seedReviewRepository,
} from "./support/review-fixture.js"

test.use(TUI_TEST_CONFIG)

for (const scenario of [
	{
		name: "complete zero-finding",
		partial: false,
		finalText: "Review complete: 0 final findings.",
		coverage: "Complete review coverage.",
		lensStatus: "submitted",
	},
	{
		name: "partial with unfinished lens",
		partial: true,
		finalText: "Review partial: 0 final findings.",
		coverage: "unfinished lenses: spec",
		lensStatus: "failed",
	},
] as const) {
	test(`review command reports a ${scenario.name} run`, async ({ terminal }) => {
		await runKimchiSession(
			terminal,
			{
				artifactName: `review-command-${scenario.partial ? "partial" : "complete"}`,
				gitInit: true,
				extraArgs: ["--yolo", "--no-approve", "--plan=false"],
				seedHome: (_homeDir, workDir) => seedReviewRepository(workDir),
				responses: reviewResponseScripts({ partial: scenario.partial }),
			},
			async () => {
				terminal.submit("/review working-tree --lens spec --concurrency 1")
				await waitForText(terminal, "Review scope pinned:", { full: true })
				await waitForText(terminal, "spec (Selected with --lens.)", { full: true })
				await waitForText(terminal, "Effective concurrency: 1", { full: true })
				await waitForText(terminal, scenario.finalText, { full: true })
				await waitForText(terminal, scenario.coverage, { full: true })
				expect(viewText(terminal)).toContain(`spec: ${scenario.lensStatus}`)
			},
		)
	})
}

test("review command interruption terminates commands, finalizes partial coverage, and cleans resources", async ({
	terminal,
}) => {
	let interruption: ReviewInterruptionFixture | undefined
	let pid: number | undefined
	let grandchildPid: number | undefined
	const requiredInterruption = () => {
		if (!interruption) throw new Error("Interruption fixture was not initialized")
		return interruption
	}
	await runKimchiSession(
		terminal,
		{
			artifactName: "review-command-interrupt",
			gitInit: true,
			extraArgs: ["--yolo", "--no-approve", "--plan=false"],
			seedHome: (homeDir, workDir) => {
				interruption = createReviewInterruptionFixture(homeDir)
				seedReviewRepository(workDir)
			},
			responses: [reviewInterruptionResponseScript(() => requiredInterruption().toolArguments)],
		},
		async (fixture) => {
			try {
				terminal.submit("/review working-tree --lens spec")
				await poll(() => existsSync(requiredInterruption().started), 100, 15_000).then((seen) =>
					expect(seen).toBe(true),
				)
				pid = Number(readFileSync(requiredInterruption().pidFile, "utf8"))
				grandchildPid = Number(readFileSync(requiredInterruption().grandchildPidFile, "utf8"))
				terminal.keyPress(Key.Escape)
				await waitForText(terminal, "Review partial: 0 final findings.", { timeoutMs: 20_000 })
				await waitForText(terminal, "unfinished lenses: spec")
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_100))
				expect(existsSync(requiredInterruption().survived)).toBe(false)
				if (pid === undefined || grandchildPid === undefined) throw new Error("Missing reviewer command PID")
				expect(() => process.kill(pid, 0)).toThrow()
				expect(() => process.kill(grandchildPid, 0)).toThrow()
				expect(existsSync(join(fixture.workDir, ".kimchi", "review-output", "active-review.json"))).toBe(false)
				const runsRoot = join(fixture.workDir, ".kimchi", "review-output", "runs")
				const [run] = readdirSync(runsRoot)
				if (run === undefined) throw new Error("Missing cancellation run directory")
				const state = JSON.parse(readFileSync(join(runsRoot, run, "state", "panel.json"), "utf8"))
				expect(state.lenses[0].status).toBe("cancelled")
				expect(git(fixture.workDir, "for-each-ref", "--format=%(refname)", "refs/kimchi/review/snapshots/")).toBe("")
				expect(git(fixture.workDir, "worktree", "list", "--porcelain")).not.toContain("kimchi-review-worktrees")
			} finally {
				for (const processId of [pid, grandchildPid]) {
					if (processId) {
						try {
							process.kill(processId, "SIGKILL")
						} catch {}
					}
				}
			}
		},
	)
})
