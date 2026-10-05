import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { savePlanMarkdown } from "../../shared/planning/plan-markdown.js"
import { createWorkScopeSnapshot } from "../__mocks__/work-scope.js"
import { findWorkContinuation } from "./continuation.js"
import { type FileTransition, readAttributedFileState, readRepositoryTransitions } from "./file-transitions.js"
import * as scope from "./scope.js"

vi.mock("./file-transitions.js", () => ({
	readRepositoryTransitions: vi.fn(),
	readAttributedFileState: vi.fn(),
}))

let cwd: string
const planningWork = "11111111-1111-4111-8111-111111111111"
const otherWork = "22222222-2222-4222-8222-222222222222"
const after = { blob: "b".repeat(40), mode: "100644" }
let transitions: FileTransition[]
function artifact(overrides: Partial<FileTransition> = {}): FileTransition {
	return {
		type: "file_transition",
		transitionId: randomUUID(),
		toolCallId: "write-plan",
		sessionId: "planner",
		workId: planningWork,
		cwd,
		repository: join(cwd, ".git"),
		worktree: cwd,
		path: "docs/adr/decision.md",
		baseline: "a".repeat(40),
		baselineFile: null,
		before: null,
		after,
		cursor: { bytes: 0, digest: "empty" },
		branch: "feature",
		recordedAt: new Date().toISOString(),
		...overrides,
	}
}
beforeEach(() => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-continuation-")))
	vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"))
	const captured = createWorkScopeSnapshot(join(cwd, ".git"))
	vi.spyOn(scope, "captureWorkScope").mockResolvedValue(captured)
	vi.spyOn(scope, "readWorkScope").mockReturnValue(captured.scope)
	mkdirSync(join(cwd, "docs/adr"), { recursive: true })
	writeFileSync(join(cwd, "docs/adr/decision.md"), "# Decision\n")
	transitions = [artifact()]
	vi.mocked(readRepositoryTransitions).mockImplementation(async () => ({
		repository: join(cwd, ".git"),
		worktree: cwd,
		branch: "feature",
		transitions,
	}))
	vi.mocked(readAttributedFileState).mockResolvedValue(after)
})
afterEach(() => {
	vi.clearAllMocks()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(cwd, { recursive: true, force: true })
})

describe("continuing saved work", () => {
	it.each([
		"path",
		"paste",
	])("keeps the accepted %s bytes when the file changes during the final account check", async (kind) => {
		const saved = savePlanMarkdown({
			cwd,
			name: "accepted",
			planText: "# Accepted\r\nOriginal bytes.\r\n",
			workId: planningWork,
		})
		const content = readFileSync(saved.path, "utf8")
		const captured = createWorkScopeSnapshot(join(cwd, ".git"))
		vi.mocked(scope.captureWorkScope).mockImplementation(async () => {
			const path = kind === "path" ? saved.path : saved.snapshotPath
			if (!path) throw new Error("Missing retained plan")
			writeFileSync(path, `<!-- kimchi-work-id: ${planningWork} -->\n# Replacement\n`)
			return captured
		})
		expect(
			await findWorkContinuation({ cwd }, kind === "path" ? `Implement ${saved.path}` : content, captured),
		).toMatchObject({
			workId: planningWork,
			evidence: { contentHash: saved.contentHash },
		})
	})

	it.each(["plain", "fenced", "skill"])("continues a %s pasted retained plan without its path", async (wrapper) => {
		const saved = savePlanMarkdown({
			cwd,
			name: "pasted",
			planText: `# Add export\nCreate docs/new.md and src/export.ts.\n\nExample metadata:\n<!-- kimchi-work-id: ${otherWork} -->\n`,
			workId: planningWork,
		})
		const content = readFileSync(saved.path, "utf8")
		rmSync(saved.path)
		const prompt =
			wrapper === "fenced"
				? `Implement this plan:\n\n\`\`\`markdown\n${content}\`\`\`\nThen run tests.`
				: wrapper === "skill"
					? `<skill name="implement" location="/skills/implement/SKILL.md">\nSee examples/template.md.\n</skill>\n\n${content}`
					: `Implement this plan:\n${content}`
		expect(await findWorkContinuation({ cwd }, prompt.replaceAll("\n", "\r\n"))).toMatchObject({
			workId: planningWork,
			source: "pasted-plan",
			evidence: { path: saved.snapshotPath },
		})
	})
	it("does not use a saved plan pasted into the skill template", async () => {
		const saved = savePlanMarkdown({ cwd, name: "template", planText: "# Template\n", workId: planningWork })
		const prompt = `<skill name="implement" location="/skills/implement/SKILL.md">\n${readFileSync(saved.path, "utf8")}\n</skill>`
		expect(await findWorkContinuation({ cwd }, prompt)).toBeUndefined()
	})
	it.each(["unknown", "changed", "marker-only"])("does not adopt a %s pasted plan", async (kind) => {
		const saved = savePlanMarkdown({
			cwd,
			name: "known",
			planText: "# Known plan\nAdd export.\n",
			workId: planningWork,
		})
		const content = readFileSync(saved.path, "utf8")
		const prompt =
			kind === "unknown"
				? content.replace(planningWork, otherWork)
				: kind === "changed"
					? content.replace("Add export.", "Remove authentication.")
					: content.split("\n")[0]
		expect(await findWorkContinuation({ cwd }, prompt)).toBeUndefined()
	})
	it("does not choose between conflicting pasted plans or an unknown outside path", async () => {
		const first = savePlanMarkdown({ cwd, name: "first", planText: "# First\n", workId: planningWork })
		const second = savePlanMarkdown({ cwd, name: "second", planText: "# Second\n", workId: otherWork })
		const content = readFileSync(first.path, "utf8")
		expect(await findWorkContinuation({ cwd }, `${content}\n${readFileSync(second.path, "utf8")}`)).toBeUndefined()
		expect(await findWorkContinuation({ cwd }, `${content}\nAlso follow missing.md`)).toBeUndefined()
		expect(await findWorkContinuation({ cwd }, `${content}\nAlso follow ${second.path}`)).toBeUndefined()
	})
	it("resolves a scoped native plan without requiring file-transition evidence", async () => {
		const saved = savePlanMarkdown({ cwd, name: "feature", planText: "# Plan", workId: planningWork })
		vi.mocked(readRepositoryTransitions).mockResolvedValue(undefined)
		expect(await findWorkContinuation({ cwd }, `Implement ${saved.path}`)).toMatchObject({
			workId: planningWork,
			source: "saved-plan",
			evidence: { path: saved.path },
		})
	})
	it.each([
		"Implement docs/adr/decision.md",
		"/skill:implement @docs/adr/decision.md",
		"Follow [the ADR](docs/adr/decision.md).",
		"Follow [the ADR section](docs/adr/decision.md#steps).",
	])("continues the exact saved artifact named by the user: %s", async (text) => {
		expect(await findWorkContinuation({ cwd }, text)).toMatchObject({
			workId: planningWork,
			source: "named-artifact",
			evidence: { path: join(cwd, "docs/adr/decision.md"), transitionId: transitions[0].transitionId },
		})
	})
	it("uses user arguments after skill expansion and ignores paths in the skill body", async () => {
		const prompt =
			'<skill name="implement" location="/skills/implement/SKILL.md">\nImplement examples/example.md.\n</skill>'
		expect(await findWorkContinuation({ cwd }, prompt)).toBeUndefined()
		expect(await findWorkContinuation({ cwd }, `${prompt}\n\ndocs/adr/decision.md`)).toMatchObject({
			workId: planningWork,
			source: "named-artifact",
		})
	})
	it("requires the saved artifact to remain unchanged", async () => {
		vi.mocked(readAttributedFileState).mockResolvedValue({ ...after, blob: "changed" })
		expect(await findWorkContinuation({ cwd }, "Implement docs/adr/decision.md")).toBeUndefined()
	})
	it("does not choose an artifact that multiple works edited", async () => {
		transitions.push(artifact({ workId: otherWork }))
		expect(await findWorkContinuation({ cwd }, "Implement docs/adr/decision.md")).toBeUndefined()
	})
	it("does not resolve conflicting saved-plan and artifact owners", async () => {
		const plan = savePlanMarkdown({ cwd, name: "other", planText: "# Other", workId: otherWork })
		expect(await findWorkContinuation({ cwd }, `Implement docs/adr/decision.md and ${plan.path}`)).toBeUndefined()
	})
	it("leaves an unknown artifact unresolved", async () => {
		expect(await findWorkContinuation({ cwd }, "Implement docs/adr/missing.md")).toBeUndefined()
	})
	it("does not ignore an unknown Markdown link with a section fragment", async () => {
		expect(
			await findWorkContinuation({ cwd }, "Implement [the other design](docs/adr/missing.md#details)."),
		).toBeUndefined()
	})
	it.each([
		"Explain what a closure is.",
		"/skill:implement",
	])("leaves a message without a saved file unresolved: %s", async (text) => {
		expect(await findWorkContinuation({ cwd }, text)).toBeUndefined()
	})
	it("does not forget an older competing artifact owner", async () => {
		transitions.unshift(
			artifact({
				workId: otherWork,
				recordedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
			}),
		)
		expect(await findWorkContinuation({ cwd }, "Implement docs/adr/decision.md")).toBeUndefined()
	})
})
