import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
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

const ENABLED_REVIEW_ARGS = ["--yolo", "--no-approve", "--enable-experimental-features"]

describe("ACP review command", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
	})

	for (const scenario of [
		{
			name: "complete finding",
			partial: false,
			finding: true,
			finalText: "Review complete: 1 final finding.",
			coverage: "Complete review coverage.",
		},
		{
			name: "partial with unfinished lens",
			partial: true,
			finding: false,
			finalText: "Review partial: 0 final findings.",
			coverage: "unfinished lenses: spec",
		},
	] as const) {
		it(
			`reports a ${scenario.name} run from the shared panel`,
			async () => {
				fixture = await startAcpFixture({
					artifactName: `acp-review-command-${scenario.partial ? "partial" : "complete"}`,
					responses: reviewResponseScripts({ partial: scenario.partial, finding: scenario.finding }),
					seedHome: (_homeDir, workDir) => {
						seedReviewRepository(workDir)
						writeFileSync(join(workDir, REVIEW_VALUE_FILE), "export const value = 1\nexport const changed = false\n")
					},
					extraArgs: ENABLED_REVIEW_ARGS,
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
				if (scenario.finding) {
					expect(messages).toContain("P1 value.ts:2")
					expect(messages).toContain("New export changes behavior without a guard")
				} else {
					expect(messages).toContain("No findings.")
				}
			},
			STARTUP_TIMEOUT_MS + 60_000,
		)
	}

	it(
		"keeps /review unregistered and inert without the experimental opt-in",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "acp-review-command-disabled",
				responses: [],
				seedHome: (_homeDir, workDir) => seedReviewRepository(workDir),
			})
			const sessionId = await newSession(fixture, fixture.workDir)
			await waitFor(
				() => commandNames(fixture as AcpFixture, sessionId),
				(names) => names.length > 0,
			)
			expect(commandNames(fixture, sessionId)).not.toContain("review")
			// An unregistered command follows the ordinary unknown-command/model-prompt
			// path; it must never dispatch the review coordinator.
			const response = await prompt(fixture, sessionId, "/review working-tree")
			expect(response.stopReason).not.toBe("TIMEOUT")
			expect(JSON.stringify(fixture.client.extNotifications)).not.toContain("Review scope pinned:")
			expect(existsSync(join(fixture.workDir, ".kimchi", "review-output"))).toBe(false)
		},
		STARTUP_TIMEOUT_MS + 30_000,
	)

	it(
		"preserves the exact original notification sequence and payloads",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "acp-review-notification-contract",
				responses: reviewResponseScripts({ finding: true }),
				seedHome: (_homeDir, workDir) => {
					seedReviewRepository(workDir)
					writeFileSync(join(workDir, REVIEW_VALUE_FILE), "export const value = 1\nexport const changed = false\n")
				},
				extraArgs: ENABLED_REVIEW_ARGS,
			})
			const sessionId = await newSession(fixture, fixture.workDir)
			await waitFor(
				() => commandNames(fixture as AcpFixture, sessionId),
				(names) => names.includes("review"),
			)
			const before = fixture.client.extNotifications.length
			await prompt(fixture, sessionId, "/review working-tree --lens spec --concurrency 1")
			const runsRoot = join(fixture.workDir, ".kimchi", "review-output", "runs")
			const [run] = readdirSync(runsRoot)
			if (!run) throw new Error("Missing review run for notification assertions")
			const runDir = realpathSync(join(runsRoot, run))
			const state = JSON.parse(readFileSync(join(runDir, "state", "panel.json"), "utf8"))
			const events = fixture.client.extNotifications.slice(before).flatMap((notification) => {
				if (notification.method !== "_kimchi.dev/pi_notify") return []
				const params = notification.params as { method?: unknown; message?: unknown; widgetLines?: unknown }
				if (params.method === "notify" && typeof params.message === "string") {
					return [{ kind: "notify", text: params.message }]
				}
				if (params.method === "setWidget" && Array.isArray(params.widgetLines)) {
					return [{ kind: "setWidget", lines: params.widgetLines }]
				}
				return []
			})
			const baseline = JSON.parse(
				readFileSync(join("tests/fixtures/review-command/acp-legacy-notifications.json"), "utf8"),
			) as {
				source: string
				events: Array<{ kind: "notify" | "setWidget"; text?: string; lines?: string[] }>
			}
			const checkoutDir = realpathSync(fixture.workDir)
			const normalize = (value: string) =>
				value
					.replaceAll(state.scope.pinned.headSha, "{{HEAD_SHA}}")
					.replaceAll(state.scope.pinned.baseSha, "{{BASE_SHA}}")
					.replaceAll(runDir, "{{RUN_DIR}}")
					.replaceAll(checkoutDir, "{{CHECKOUT}}")
			expect(
				events.map((event) => {
					if (event.kind === "setWidget") return { ...event, lines: event.lines?.map(normalize) }
					return { ...event, text: event.text ? normalize(event.text) : event.text }
				}),
			).toEqual(baseline.events)
		},
		STARTUP_TIMEOUT_MS + 60_000,
	)

	it(
		"returns explicit target syntax for bare input without opening a picker",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "acp-review-command-bare",
				responses: [],
				seedHome: (_homeDir, workDir) => seedReviewRepository(workDir),
				extraArgs: ["--enable-experimental-features"],
			})
			const sessionId = await newSession(fixture, fixture.workDir)
			await prompt(fixture, sessionId, "/review")
			const messages = await waitFor(
				() => JSON.stringify(fixture?.client.extNotifications ?? []),
				(value) => value.includes("/review working-tree [--fetch]"),
			)
			expect(messages).toContain("/review working-tree [--fetch]")
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
				extraArgs: ENABLED_REVIEW_ARGS,
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
			let grandchildPid: number | undefined
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
				extraArgs: ENABLED_REVIEW_ARGS,
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
				grandchildPid = Number(readFileSync(requiredInterruption().grandchildPidFile, "utf8"))
				await fixture.conn.notify("session/cancel", { sessionId })
				expect((await pending).stopReason).toBe("cancelled")
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
				expect(state.coverage).toMatchObject({ status: "partial", unfinished_lenses: ["spec"] })
				expect(JSON.stringify(fixture.client.extNotifications)).toContain("unfinished lenses: spec")
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
		STARTUP_TIMEOUT_MS + 60_000,
	)
})
