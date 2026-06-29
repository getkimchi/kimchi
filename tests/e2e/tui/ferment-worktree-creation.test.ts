/**
 * E2E TUI test: `/ferment new` creates a dedicated git worktree when
 * `ferments.worktree.enabled` is true.
 *
 * Flow:
 * 1. Launch TUI in a git repo with `ferments.worktree.enabled: true`.
 * 2. Make an initial commit so HEAD exists.
 * 3. User types `/ferment` → submits intent.
 * 4. Fake model calls propose_ferment_scoping.
 * 5. User confirms "Start execution".
 * 6. confirmPendingScope creates a dedicated worktree at
 *    <repoRoot>/.worktrees/ferment-<shortId> on branch ferment/<shortId>.
 * 7. Verify the ferment JSON, git worktree list, and git branch list.
 */

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const PROPOSE_SCOPING_PAYLOAD = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "Worktree Isolation Check",
	goal: "Verify that a dedicated git worktree is created when worktree isolation is enabled.",
	success_criteria: [
		"Dedicated worktree exists on disk",
		"Ferment JSON records the worktree path, branch, and commit",
		"The worktree and branch are cleaned up after terminal state",
	],
	constraints: [],
	assumptions: "The repo has an initial commit so the ferment branch can be created.",
	phases: [
		{
			name: "Verify worktree",
			goal: "Confirm the worktree was created.",
			steps: [
				{
					description: "Inspect the ferment artifact and git worktree list.",
					verify: "git worktree list",
				},
			],
		},
	],
	questions: [],
	gates: [
		{
			id: "P1",
			verdict: "pass",
			rationale: "Step has a verify command",
			evidence: "git worktree list",
		},
		{
			id: "P2",
			verdict: "omitted",
			rationale: "Single phase",
			evidence: "n/a",
		},
		{
			id: "P3",
			verdict: "pass",
			rationale: "Worktree path and branch will be checked",
			evidence: "n/a",
		},
	],
})

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" })
}

test("/ferment new creates a dedicated worktree when worktree isolation is enabled", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-worktree-creation",
			gitInit: true,
			preLaunch(fixture) {
				// Enable per-ferment worktree isolation in project config.
				const kimchiDir = join(fixture.workDir, ".kimchi")
				mkdirSync(kimchiDir, { recursive: true })
				writeFileSync(
					join(kimchiDir, "config.json"),
					JSON.stringify({ ferments: { worktree: { enabled: true } } }, null, "\t"),
					"utf-8",
				)
				// Make an initial commit so HEAD exists for branching.
				git(fixture.workDir, "config", "user.email", "test@example.com")
				git(fixture.workDir, "config", "user.name", "Test User")
				git(fixture.workDir, "commit", "--allow-empty", "-m", "initial commit")
			},
			responses: [
				// Turn 1: model calls propose_ferment_scoping.
				{
					toolCalls: [
						{
							function: {
								name: "propose_ferment_scoping",
								arguments: PROPOSE_SCOPING_PAYLOAD,
							},
						},
					],
				},
				// Turn 2 (after tool result): short text.
				{ stream: ["I've outlined the scope."] },
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
			terminal.submit("Add worktree isolation test")
			trace.step("submitted intent")

			// Stage 5: the plan-review dialog appears after the model's
			// propose_ferment_scoping call.
			await waitForText(terminal, "Proceed with this plan?", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await waitForText(terminal, "Start execution", {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("plan-review dialog visible")

			// Stage 6: confirm → confirmPendingScope creates the worktree.
			terminal.submit("")
			trace.step("confirmed 'Start execution'")

			// Stage 7: capture the source commit from the pre-launch setup.
			const initialCommit = git(fixture.workDir, "rev-parse", "HEAD").trim()

			// Stage 8: find the scoped ferment artifact.
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

			// Stage 9: poll until updateWorktree persists the dedicated worktree path.
			const pollDeadline = Date.now() + STREAM_TIMEOUT_MS
			while (scopedPath && Date.now() < pollDeadline) {
				const latest = JSON.parse(readFileSync(scopedPath, "utf-8"))
				const latestWorktree = (latest.worktree ?? {}) as Record<string, unknown>
				if (typeof latestWorktree.path === "string" && latestWorktree.path.includes(".worktrees/ferment-")) {
					scopedArtifact = latest
					break
				}
				await new Promise((resolve) => setTimeout(resolve, 250))
			}

			// Stage 10: verify worktree fields.
			const artifact = scopedArtifact as Record<string, unknown>
			expect(artifact).toHaveProperty("id")
			const id = String(artifact.id)
			const shortId = id.slice(0, 8)
			// macOS /var is a symlink to /private/var; realpathSync so the
			// expected path matches the canonical path recorded by git.
			const expectedPath = join(realpathSync(fixture.workDir), ".worktrees", `ferment-${shortId}`)

			expect(artifact).toHaveProperty("worktree")
			const worktree = artifact.worktree as Record<string, unknown>
			expect(worktree.path).toBe(expectedPath)
			expect(worktree.branch).toBe(`ferment/${shortId}`)
			expect(worktree.commit).toBe(initialCommit)
			trace.step(`artifact worktree fields verified: ${expectedPath}`)

			// Stage 11: git worktree list contains the path.
			const worktreeList = git(fixture.workDir, "worktree", "list")
			expect(worktreeList).toContain(expectedPath)
			trace.step("git worktree list contains dedicated worktree")

			// Stage 12: git branch list contains the branch.
			const branchList = git(fixture.workDir, "branch", "--list", `ferment/${shortId}`)
			expect(branchList).toContain(`ferment/${shortId}`)
			trace.step("git branch list contains ferment branch")

			// Stage 13: the worktree HEAD matches the source commit.
			const worktreeHead = git(expectedPath, "rev-parse", "HEAD").trim()
			expect(worktreeHead).toBe(initialCommit)
			trace.step("worktree HEAD matches source commit")
		},
	)
})
