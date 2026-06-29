/**
 * E2E TUI test: `/ferment new` runs planning and produces a scoped ferment.
 *
 * Flow:
 * 1. Launch TUI without --plan or --ferment-oneshot.
 * 2. User types `/ferment` → intent prompt appears.
 * 3. User submits "Add a cache layer" as the intent.
 * 4. The fake model responds with a propose_ferment_scoping tool call.
 * 5. The host shows the plan-review dialog ("Proceed with this plan?").
 * 6. User confirms → ferment is scoped with phases.
 *
 * This test covers the `/ferment` entry path (not `--plan` mode and not
 * `--ferment-oneshot`). The `--plan → Start as ferment` path is exercised by
 * `plan-to-ferment-promo.test.ts`; `--ferment-oneshot` by
 * `oneshot-bypasses-dropdown.test.ts`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { Key, expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const PROPOSE_SCOPING_PAYLOAD = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "Add Cache Layer",
	goal: "Add an in-memory cache layer to the read path so repeated queries return within 1ms.",
	success_criteria: [
		"Cache module exposes get/set/del with TTL",
		"Existing read path uses cache.get before the slow lookup",
		"pnpm vitest run src/cache exits 0",
	],
	constraints: ["no new dependencies", "TypeScript strict mode preserved"],
	assumptions: "The slow lookup is idempotent and the existing tests can be re-run against the cached variant.",
	phases: [
		{
			name: "Cache module",
			goal: "Create the cache module and wire it into the read path.",
			steps: [
				{
					description: "Write src/cache.ts with get/set/del and TTL eviction.",
					verify: "pnpm vitest run src/cache.test.ts",
				},
				{
					description: "Replace direct lookup in the read path with cache.get + fallback.",
					verify: "pnpm vitest run src/read-path.test.ts",
				},
			],
		},
	],
	questions: [],
	gates: [
		{
			id: "P1",
			verdict: "pass",
			rationale: "Each step has a verify command",
			evidence: "step-1: vitest; step-2: vitest",
		},
		{
			id: "P2",
			verdict: "omitted",
			rationale: "Single phase, no ordering concerns",
			evidence: "n/a",
		},
		{
			id: "P3",
			verdict: "pass",
			rationale: "Validation gate will check files + tests",
			evidence: "n/a",
		},
	],
})

test("/ferment new runs planning and produces a scoped ferment artifact", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-new-runs-planning",
			gitInit: true,
			responses: [
				// Turn 1: emit orientation text first (required by the
				// first-turn-orientation guard) then call propose_ferment_scoping.
				{
					stream: ["I'll outline the scope."],
					toolCalls: [
						{
							function: {
								name: "propose_ferment_scoping",
								arguments: PROPOSE_SCOPING_PAYLOAD,
							},
						},
					],
				},
				// Turn 2 (after tool result): short text, no trailing "?".
				{ stream: ["I've outlined the scope for the cache layer feature."] },
				// Turn 3 (post-confirmation): keeps session alive.
				{},
			],
		},
		async (fixture, trace) => {
			// Stage 1: ready prompt visible.
			await waitForText(terminal, "ask anything or type / for commands", {
				timeoutMs: STARTUP_TIMEOUT_MS,
			})
			trace.step("ready prompt visible")

			// Stage 2: enter ferment. Type then Enter separately — one-shot
			// "/ferment\r" can race startup (ferment-phase-review.test.ts:42-48).
			terminal.write("/ferment")
			await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /ferment")
			terminal.submit("")
			trace.step("ran /ferment")

			// Stage 3: intent prompt appears.
			await waitForText(terminal, "would you like to ferment", {
				timeoutMs: STARTUP_TIMEOUT_MS,
			})
			trace.step("intent prompt visible")

			// Stage 4: submit intent → model proposes scoping.
			terminal.submit("Add a cache layer")
			trace.step("submitted intent")

			// Stage 5: the plan-review dialog appears after the model's
			// propose_ferment_scoping call. It renders the full plan markdown
			// followed by "Proceed with this plan?" with 3 options:
			//   > Start execution
			//     Start execution in auto mode (run all stages without stopping)
			//     Let me say something
			// (DECISION_OPTIONS at plan-review.ts:16-20).
			await waitForText(terminal, "Proceed with this plan?", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await waitForText(terminal, "Start execution", {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("plan-review dialog visible — 'Proceed with this plan?' / 'Start execution'")

			// Stage 6: confirm by pressing Enter (default first option
			// "Start execution"). confirmPendingScope runs and persists the
			// scoped ferment to .kimchi/ferments/<id>.json with status
			// "planned" and full phase structure.
			terminal.submit("")
			trace.step("confirmed 'Start execution'")

			// Stage 7: verify the ferment artifact was written.
			const fermentsDir = join(fixture.workDir, ".kimchi", "ferments")
			const deadline = Date.now() + STREAM_TIMEOUT_MS
			let scopedArtifact: Record<string, unknown> | undefined
			let scopedPath: string | undefined
			while (Date.now() < deadline) {
				try {
					const candidates = readdirSync(fermentsDir)
						.filter((f) => f.endsWith(".json"))
						.map((f) => {
							const fullPath = join(fermentsDir, f)
							const stat = statSync(fullPath)
							return { path: fullPath, mtime: stat.mtimeMs, name: f }
						})
						.sort((a, b) => b.mtime - a.mtime)
					for (const c of candidates) {
						const content = JSON.parse(readFileSync(c.path, "utf-8"))
						const phases = Array.isArray(content.phases) ? content.phases : []
						if (phases.length > 0) {
							scopedArtifact = content
							scopedPath = c.path
							break
						}
					}
					if (scopedArtifact) break
				} catch {
					// dir doesn't exist yet or unreadable
				}
				await new Promise((resolve) => setTimeout(resolve, 250))
			}
			expect(scopedArtifact).toBeDefined()
			trace.step(`scoped ferment artifact found: ${scopedPath?.split("/").pop()}`)

			// Stage 8: verify the artifact contents.
			const artifact = scopedArtifact as Record<string, unknown>
			expect(artifact).toHaveProperty("id")
			expect(artifact).toHaveProperty("name")
			expect(artifact).toHaveProperty("goal")
			expect(String(artifact.goal)).toContain("in-memory cache layer")
			expect(artifact).toHaveProperty("successCriteria")
			expect(Array.isArray(artifact.successCriteria)).toBe(true)
			const criteria = artifact.successCriteria as unknown[]
			expect(criteria.length).toBeGreaterThan(0)
			expect(artifact).toHaveProperty("phases")
			const phases = artifact.phases as Array<Record<string, unknown>>
			expect(phases.length).toBe(1)
			expect(phases[0].name).toBe("Cache module")
			const steps = phases[0].steps as Array<Record<string, unknown>>
			expect(steps.length).toBe(2)
			expect(String(steps[0].description)).toContain("cache.ts")
			expect(String(steps[1].description)).toContain("read path")
			trace.step("ferment artifact shape verified — 1 phase, 2 steps, scoped goal")

			// Stage 9: verify the host sent the scoping nudge.
			const scopingRequests = fixture.fake.requests.filter(
				(req) =>
					req.url.startsWith("/openai/v1/chat/completions") &&
					JSON.stringify(req.body).includes("propose_ferment_scoping"),
			)
			expect(scopingRequests.length).toBeGreaterThan(0)
			trace.step(`host sent ${scopingRequests.length} request(s) referencing propose_ferment_scoping`)
		},
	)
})
