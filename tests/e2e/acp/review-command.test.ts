import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	createReviewInterruptionFixture,
	git,
	REVIEW_VALUE_FILE,
	type ReviewInterruptionFixture,
	reviewInterruptionResponseScript,
	reviewResponseScripts,
	seedReviewRepository,
} from "../tui/support/review-fixture.js"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { commandNames, newSession, prompt, waitFor } from "./support/scenarios.js"

describe("ACP review command", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
	})

	for (const scenario of [
		{
			name: "complete zero-finding",
			partial: false,
			finalText: "Review complete: 0 final findings.",
			coverage: "Complete review coverage.",
		},
		{
			name: "partial with unfinished lens",
			partial: true,
			finalText: "Review partial: 0 final findings.",
			coverage: "unfinished lenses: spec",
		},
	] as const) {
		it(
			`reports a ${scenario.name} run from the shared panel`,
			async () => {
				fixture = await startAcpFixture({
					artifactName: `acp-review-command-${scenario.partial ? "partial" : "complete"}`,
					responses: reviewResponseScripts({ partial: scenario.partial }),
					seedHome: (_homeDir, workDir) => seedReviewRepository(workDir),
					extraArgs: ["--yolo", "--no-approve"],
				})
				const sessionId = await newSession(fixture, fixture.workDir)
				await waitFor(
					() => commandNames(fixture as AcpFixture, sessionId),
					(names) => names.includes("review"),
				)
				const response = await prompt(fixture, sessionId, "/review working-tree --lens spec --concurrency 1")
				expect(response.stopReason).not.toBe("ERROR")
				expect(response.stopReason).not.toBe("TIMEOUT")
				await waitFor(
					() => JSON.stringify(fixture?.client.extNotifications ?? []),
					(messages) => messages.includes(scenario.finalText) && messages.includes(scenario.coverage),
				)
				const messages = JSON.stringify(fixture.client.extNotifications)
				expect(messages).toContain("Review scope pinned:")
				expect(messages).toContain("spec (Selected with --lens.)")
				expect(messages).toContain("Effective concurrency: 1")
			},
			STARTUP_TIMEOUT_MS + 60_000,
		)
	}

	it(
		"returns explicit target syntax for bare input without opening a picker",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "acp-review-command-bare",
				responses: [],
				seedHome: (_homeDir, workDir) => seedReviewRepository(workDir),
			})
			const sessionId = await newSession(fixture, fixture.workDir)
			await prompt(fixture, sessionId, "/review")
			expect(JSON.stringify(fixture.client.extNotifications)).toContain("/review working-tree [--fetch]")
			expect(fixture.client.permissionRequests).toHaveLength(0)
			expect(fixture.client.elicitationRequests).toHaveLength(0)
		},
		STARTUP_TIMEOUT_MS + 30_000,
	)

	it(
		"starts consecutive fresh runs without reviewing Kimchi-generated artifacts",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "acp-review-command-consecutive",
				responses: [...reviewResponseScripts(), ...reviewResponseScripts()],
				seedHome: (_homeDir, workDir) => {
					seedReviewRepository(workDir)
					writeFileSync(
						join(workDir, REVIEW_VALUE_FILE),
						"export const value = 1\nexport const changed = true\nexport const intendedEdit = true\n",
					)
				},
				extraArgs: ["--yolo", "--no-approve"],
			})
			const sessionId = await newSession(fixture, fixture.workDir)
			await prompt(fixture, sessionId, "/review working-tree --lens spec")
			await prompt(fixture, sessionId, "/review working-tree --lens spec")
			const runsRoot = join(fixture.workDir, ".kimchi", "review-output", "runs")
			const runs = readdirSync(runsRoot)
			expect(runs).toHaveLength(2)
			expect(existsSync(join(fixture.workDir, ".kimchi", "review-output", "active-review.json"))).toBe(false)
			for (const run of runs) {
				const state = JSON.parse(readFileSync(join(runsRoot, run, "state", "panel.json"), "utf8"))
				expect(state.coverage.status).toBe("complete")
				const paths = git(
					fixture.workDir,
					"diff",
					"--name-only",
					state.scope.pinned.baseSha,
					state.scope.pinned.headSha,
				)
				expect(paths.split("\n").filter(Boolean)).toEqual([REVIEW_VALUE_FILE])
			}
		},
		STARTUP_TIMEOUT_MS + 60_000,
	)

	it(
		"cancels an in-flight reviewer command, finalizes partial coverage, and cleans all resources",
		async () => {
			let interruption: ReviewInterruptionFixture | undefined
			let pid: number | undefined
			const requiredInterruption = () => {
				if (!interruption) throw new Error("Interruption fixture was not initialized")
				return interruption
			}
			fixture = await startAcpFixture({
				artifactName: "acp-review-command-cancel",
				responses: [reviewInterruptionResponseScript(() => requiredInterruption().toolArguments)],
				seedHome: (homeDir, workDir) => {
					interruption = createReviewInterruptionFixture(homeDir)
					seedReviewRepository(workDir)
				},
				extraArgs: ["--yolo", "--no-approve"],
			})
			try {
				const sessionId = await newSession(fixture, fixture.workDir)
				const pending = fixture.conn.request("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: "/review working-tree --lens spec" }],
				})
				await waitFor(
					() => existsSync(requiredInterruption().started),
					(exists) => exists,
				)
				pid = Number(readFileSync(requiredInterruption().pidFile, "utf8"))
				await fixture.conn.notify("session/cancel", { sessionId })
				expect((await pending).stopReason).toBe("cancelled")
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_100))
				expect(existsSync(requiredInterruption().survived)).toBe(false)
				if (pid === undefined) throw new Error("Missing reviewer command PID")
				expect(() => process.kill(pid, 0)).toThrow()
				expect(existsSync(join(fixture.workDir, ".kimchi", "review-output", "active-review.json"))).toBe(false)
				const runsRoot = join(fixture.workDir, ".kimchi", "review-output", "runs")
				const [run] = readdirSync(runsRoot)
				if (run === undefined) throw new Error("Missing cancellation run directory")
				const state = JSON.parse(readFileSync(join(runsRoot, run, "state", "panel.json"), "utf8"))
				expect(state.lenses[0].status).toBe("cancelled")
				expect(state.coverage).toMatchObject({ status: "partial", unfinished_lenses: ["spec"] })
				expect(JSON.stringify(fixture.client.extNotifications)).toContain("unfinished lenses: spec")
				expect(git(fixture.workDir, "for-each-ref", "--format=%(refname)", "refs/kimchi/review/snapshots/")).toBe("")
				expect(git(fixture.workDir, "worktree", "list", "--porcelain")).not.toContain("kimchi-review-worktrees")
			} finally {
				if (pid) {
					try {
						process.kill(pid, "SIGKILL")
					} catch {}
				}
			}
		},
		STARTUP_TIMEOUT_MS + 60_000,
	)
})
