import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Workflow: a draft ferment with a persisted pending-proposal sidecar is
 * pre-seeded on disk before launch. After the session is ready, the user
 * opens /ferment list, selects the draft, and chooses Continue — which
 * calls resumeFerment. Because the sidecar is present, resumeFerment
 * re-arms the plan review dialog ("Yes, this looks right") instead of
 * nudging the LLM to re-scope. The fake server's response script carries
 * no propose_ferment_scoping tool call, proving the review reopens purely
 * from the persisted sidecar with no re-proposal.
 *
 * The ferment snapshot + sidecar are written directly with node:fs (no src
 * imports) because tui-test compiles the test to plain Node where src/*.ts
 * imports don't resolve. KIMCHI_FERMENTS_DIR env pins the launched process
 * to the seeded ferments dir so it doesn't depend on project-root detection.
 */
test("draft with persisted proposal reopens plan review across session restart", async ({ terminal }) => {
	const PLAN_MARKDOWN = "## Plan: Persistent Proposal\n\n- Phase 1: Wire persistence"
	const SAMPLE_PHASES = [
		{
			name: "Phase 1",
			goal: "Wire persistence",
			steps: [{ description: "create store" }, { description: "wire resume" }],
		},
	]

	const FERMENT_ID = randomUUID()
	const NOW = new Date("2026-01-01T00:00:00.000Z").toISOString()

	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-draft-proposal-persistence",
			gitInit: true,
			// No propose_ferment_scoping in the response script: the review is
			// re-armed from disk, not from a model tool call. A benign text
			// stream keeps the (post-resume) turn non-empty without re-proposing.
			responses: [{ stream: ["Resuming the saved plan review."] }],
			seedHome(_homeDir, workDir) {
				const fermentsDir = join(workDir, ".kimchi", "ferments")
				mkdirSync(fermentsDir, { recursive: true })

				// Minimal draft ferment snapshot (FermentStorage v4 shape).
				// worktree.path resolved via realpathSync so it matches what
				// detectProjectRoot() returns inside the launched process (macOS
				// resolves /var/folders → /private/var/folders).
				const ferment = {
					id: FERMENT_ID,
					name: "Persistent Proposal",
					status: "draft",
					worktree: { path: realpathSync(workDir) },
					scoping: {},
					phases: [],
					decisions: [],
					memories: [],
					createdAt: NOW,
					updatedAt: NOW,
				}
				writeFileSync(join(fermentsDir, `${FERMENT_ID}.json`), `${JSON.stringify(ferment, null, 2)}\n`, "utf-8")

				// Persisted pending-proposal sidecar (PendingProposalData v1).
				const sidecarDir = join(fermentsDir, FERMENT_ID)
				mkdirSync(sidecarDir, { recursive: true })
				const proposal = {
					schemaVersion: 1,
					fermentId: FERMENT_ID,
					title: "Persistent Proposal",
					goal: "Persist the draft scoping proposal across restarts",
					successCriteria: ["Review reopens after restart"],
					constraints: ["No re-scoping"],
					assumptions: "single phase",
					phases: SAMPLE_PHASES,
					planMarkdown: PLAN_MARKDOWN,
					proposeIterations: 1,
					savedAt: NOW,
				}
				writeFileSync(join(sidecarDir, "pending-proposal.json"), `${JSON.stringify(proposal, null, 2)}\n`, "utf-8")

				// Pin the launched process to this ferments dir so it reads the
				// seeded snapshot regardless of project-root detection.
				return { env: { KIMCHI_FERMENTS_DIR: fermentsDir } }
			},
		},
		async (fixture, trace) => {
			// Stage 1: open the ferment list picker.
			terminal.submit("/ferment list")
			trace.step("ran /ferment list")

			// Stage 2: the seeded draft appears in the list; select it.
			await waitForText(terminal, "Persistent Proposal", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("draft listed in ferment picker")
			terminal.submit("")
			trace.step("selected the draft — resumeFerment runs")

			// Stage 3: the persisted proposal re-arms the plan review dialog
			// directly (no LLM scoping turn, no re-propose). The dialog renders
			// the plan markdown and a "Proceed with this plan?" picker.
			await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("plan review re-armed from saved proposal")
			await waitForText(terminal, "Start execution", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("plan review options visible")

			// The model must NOT have re-proposed: no propose_ferment_scoping
			// tool call reached the fake server.
			const repropose = fixture.fake.requests.find((req) =>
				JSON.stringify(req.body ?? "").includes("propose_ferment_scoping"),
			)
			if (repropose) {
				throw new Error(
					`model re-proposed scoping after restart; expected no propose_ferment_scoping tool call. Request URLs: ${JSON.stringify(fixture.fake.requests.map((r) => r.url))}`,
				)
			}
			trace.step("no propose_ferment_scoping — review reopened from sidecar")
		},
	)
})
