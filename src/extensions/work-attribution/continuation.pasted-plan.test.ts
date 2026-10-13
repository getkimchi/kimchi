import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { savePlanMarkdown } from "../../shared/planning/plan-markdown.js"
import { createWorkScopeSnapshot } from "../__mocks__/work-scope.js"
import { findWorkContinuation, hasWorkReference } from "./continuation.js"
import { readAttributedFileState, readRepositoryTransitions } from "./file-transitions.js"
import * as scope from "./scope.js"

vi.mock("./file-transitions.js", () => ({
	readRepositoryTransitions: vi.fn(),
	readAttributedFileState: vi.fn(),
}))

let cwd: string
let captured: scope.WorkScopeSnapshot
const planningWork = "11111111-1111-4111-8111-111111111111"
const otherWork = "22222222-2222-4222-8222-222222222222"
const after = { blob: "b".repeat(40), mode: "100644" }
beforeEach(() => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-pasted-plan-")))
	vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"))
	captured = createWorkScopeSnapshot(join(cwd, ".git"))
	vi.spyOn(scope, "captureWorkScope").mockResolvedValue(captured)
	vi.spyOn(scope, "readWorkScope").mockReturnValue(captured.scope)
	mkdirSync(join(cwd, "docs/adr"), { recursive: true })
	writeFileSync(join(cwd, "docs/adr/decision.md"), "# Decision\n")
	// The ADR named inside the plan was written by a different work.
	vi.mocked(readRepositoryTransitions).mockResolvedValue({
		repository: join(cwd, ".git"),
		worktree: cwd,
		branch: "feature",
		transitions: [
			{
				type: "file_transition",
				transitionId: randomUUID(),
				toolCallId: "write-adr",
				sessionId: "other",
				workId: otherWork,
				cwd,
				repository: join(cwd, ".git"),
				worktree: cwd,
				path: "docs/adr/decision.md",
				baseline: "a".repeat(40),
				baselineFile: null,
				before: null,
				after,
				cursor: { bytes: 0, digest: "empty" },
				recordedAt: new Date().toISOString(),
			},
		],
	})
	vi.mocked(readAttributedFileState).mockResolvedValue(after)
})
afterEach(() => {
	vi.clearAllMocks()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(cwd, { recursive: true, force: true })
})

it.each([
	["indented code block", (line: string) => `    ${line}`],
	["blockquote", (line: string) => `> ${line}`],
])("leaves a %s paste of another work's plan unresolved instead of selecting a path inside it", async (_kind, wrap) => {
	const saved = savePlanMarkdown({
		cwd,
		name: "export",
		planText: "# Export\nFollow docs/adr/decision.md for the storage format.\n",
		workId: planningWork,
	})
	const pasted = readFileSync(saved.path, "utf8").trimEnd().split("\n").map(wrap).join("\n")
	const prompt = `Implement this plan:\n\n${pasted}\n`
	expect(hasWorkReference(prompt)).toBe(true)
	// Docs: "A changed plan, unknown ID, or conflicting plan stays unresolved. File paths inside the
	// verified plan are its instructions, not additional work selections."
	expect(await findWorkContinuation({ cwd }, prompt, captured)).toEqual({ owned: true })
})
