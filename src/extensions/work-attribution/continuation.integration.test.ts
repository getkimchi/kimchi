import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BeforeProviderHeadersEvent, InputEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, expect, it, vi } from "vitest"
import { savePlanMarkdown } from "../../shared/planning/plan-markdown.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createWorkScopeSnapshot } from "../__mocks__/work-scope.js"
import { appendWorkRecord, createWorkAttributionExtension, getWorkId } from "../work-attribution.js"
import { createCommitTrackingBashTool } from "./commits.js"
import { findWorkContinuation } from "./continuation.js"
import { createTrackedWriteTool } from "./file-transitions.js"
import { correctWorkLink } from "./links.js"
import * as scope from "./scope.js"
import { flushWorkSummaries, readWorkRecords } from "./summary.js"

let root: string | undefined
afterEach(async () => {
	await flushWorkSummaries()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	if (root) rmSync(root, { recursive: true, force: true })
})

async function planningRepository() {
	root = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-skill-work-")))
	const cwd = join(root, "repo")
	mkdirSync(cwd)
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"))
	const captured = createWorkScopeSnapshot(join(cwd, ".git"))
	vi.spyOn(scope, "captureWorkScope").mockResolvedValue(captured)
	vi.spyOn(scope, "readWorkScope").mockReturnValue(captured.scope)
	const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
	git("init", "-q", "-b", "trunk")
	git("config", "user.name", "Continuation Test")
	git("config", "user.email", "continuation@example.invalid")
	git("config", "commit.gpgSign", "false")
	git("commit", "-q", "--allow-empty", "-m", "Baseline")
	git("update-ref", "refs/remotes/origin/trunk", "HEAD")
	git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
	git("checkout", "-q", "-b", "feature")
	const ctx = createContext({ cwd, sessionManager: { getSessionId: () => "skill-planner" } })
	const path = "docs/adr/decision.md"
	await createTrackedWriteTool(ctx, "write-adr").execute("write-adr", { path, content: "# Build the feature\n" })
	const workId = getWorkId(ctx)
	return { cwd, git, path, workId, agentDir: join(root, "agent") }
}

it("does not claim a human-written ADR after a read-only Bash call", async () => {
	const { cwd, agentDir } = await planningRepository()
	const path = "docs/adr/from-human.md"
	writeFileSync(join(cwd, path), "# Human decision\n")
	const ctx = createContext({ cwd, sessionManager: { getSessionId: () => "bash-reader" } })
	await createCommitTrackingBashTool(ctx).execute("read-adr", { command: `cat ${path}` }, undefined, undefined, ctx)

	expect(await findWorkContinuation({ cwd }, `Implement ${path}`)).toBeUndefined()
	expect(readWorkRecords(agentDir)).not.toContainEqual(
		expect.objectContaining({
			type: "file_observation",
			toolCallId: "read-adr",
			files: expect.arrayContaining([expect.objectContaining({ path })]),
		}),
	)
})

it.each(
	(["interactive", "rpc"] as const).flatMap((source) =>
		[
			"Explain what a closure is.",
			"/skill:implement",
			'<skill name="implement" location="/skills/implement/SKILL.md">\nImplement docs/adr/decision.md.\n</skill>',
		].map((text) => ({ source, text })),
	),
)("keeps unnamed work separate from a recent ADR ($source: $text)", async ({ source, text }) => {
	const { cwd, path, workId, agentDir } = await planningRepository()
	const ctx = createContext({ cwd, sessionManager: { getSessionId: () => "fresh-session" } })
	const originalWork = getWorkId(ctx)
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	const input = api.getHandler<InputEvent>("input")
	const request = api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")
	await input({ type: "input", source, text }, ctx)
	const first: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
	await request(first, ctx)
	expect(getWorkId(ctx)).toBe(originalWork)
	expect(originalWork).not.toBe(workId)

	await input({ type: "input", source, text: `Implement ${path}` }, ctx)
	const second: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
	await request(second, ctx)
	expect(getWorkId(ctx)).toBe(workId)
	const records = readWorkRecords(agentDir)
	expect(records.find((row) => row.requestId === first.headers["X-Request-Id"])?.workId).toBe(originalWork)
	expect(records.find((row) => row.requestId === second.headers["X-Request-Id"])?.workId).toBe(workId)
	expect(records).toContainEqual(
		expect.objectContaining({
			type: "work",
			sessionId: "fresh-session",
			workId,
			continuation: expect.objectContaining({ source: "named-artifact" }),
		}),
	)
})

it("continues a named skill-written ADR across worktrees without native plan mode", async () => {
	const { cwd, git, path, workId } = await planningRepository()
	expect(await findWorkContinuation({ cwd }, `/skill:implement ${path}`)).toMatchObject({
		workId,
		source: "named-artifact",
		evidence: { path: join(cwd, path), branch: "feature" },
	})
	expect(await findWorkContinuation({ cwd }, "/skill:implement")).toBeUndefined()
	git("add", path)
	git("commit", "-q", "-m", "Save the ADR")
	const otherTree = join(cwd, "..", "implementation")
	git("worktree", "add", "-q", "-b", "implementation", otherTree)
	expect(await findWorkContinuation({ cwd: otherTree }, `Implement ${path}`)).toMatchObject({
		workId,
		source: "named-artifact",
		evidence: { path: join(otherTree, path), worktree: cwd },
	})
	expect(await findWorkContinuation({ cwd: otherTree }, "/skill:implement")).toBeUndefined()
	writeFileSync(join(otherTree, path), "# Different work\n")
	expect(await findWorkContinuation({ cwd: otherTree }, `Implement ${path}`)).toBeUndefined()
})

it.each(["interactive", "rpc"] as const)("adopts a pasted plan before the first %s request", async (source) => {
	const { cwd, workId, agentDir } = await planningRepository()
	const saved = savePlanMarkdown({ cwd, name: "paste", planText: "# Plan\nImplement src/export.ts.\n", workId })
	const content = readFileSync(saved.path, "utf8")
	rmSync(saved.path)
	const ctx = createContext({ cwd, sessionManager: { getSessionId: () => "pasted-session" } })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	await api.getHandler<InputEvent>("input")({ type: "input", source, text: `Implement this:\n${content}` }, ctx)
	const request: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
	await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(request, ctx)
	expect(readWorkRecords(agentDir)).toContainEqual(
		expect.objectContaining({ type: "request", requestId: request.headers["X-Request-Id"], workId }),
	)
	await flushWorkSummaries()
	const summary = JSON.parse(readFileSync(join(agentDir, "work", workId, "work.json"), "utf8"))
	expect(summary.continuations).toContainEqual(
		expect.objectContaining({
			sessionId: "pasted-session",
			source: "pasted-plan",
			evidence: { path: saved.snapshotPath },
		}),
	)
})

it("confirms a retained plan when the agent directory uses a filesystem alias", async () => {
	const flow = await recordedPlan("snapshot", true)
	await flow.input({ type: "input", source: "interactive", text: flow.text }, flow.implementer)
	expect(readWorkRecords(flow.agentDir)).toContainEqual(
		expect.objectContaining({
			type: "work_link",
			requestIds: [flow.research, flow.producer].sort(),
		}),
	)
})

it.each([
	"interactive",
	"rpc",
] as const)("confirms the current work's saved plan before %s requests, including after restart", async (source) => {
	const flow = await recordedPlan("path")
	let api = flow.api
	for (const lifecycle of ["active", "restarted"]) {
		if (lifecycle === "restarted") {
			api = createExtensionApi()
			createWorkAttributionExtension()(api.api)
		}
		await api.getHandler<InputEvent>("input")({ type: "input", source, text: flow.text }, flow.planner)
		const request: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(request, flow.planner)
		const rows = readWorkRecords(flow.agentDir)
		expect(getWorkId(flow.planner)).toBe(flow.workId)
		expect(
			rows.find((row) => row.type === "request" && row.requestId === request.headers["X-Request-Id"]),
		).toMatchObject({
			workId: flow.workId,
			segment: { attribution: "explicit", reason: "saved-plan" },
		})
		expect(rows.filter((row) => row.type === "work_link")).toEqual([
			expect.objectContaining({ requestIds: [flow.research, flow.producer].sort() }),
		])
		expect(
			rows.filter(
				(row) => flow.original.some((original) => original.requestId === row.requestId) && row.type === "request",
			),
		).toEqual(flow.original)
		await api.getHandler("session_shutdown")({ type: "session_shutdown", reason: "quit" }, flow.planner)
	}
})

async function recordedPlan(kind: "path" | "snapshot" | "paste" | "artifact", aliasedAgentDir = false) {
	const { cwd, agentDir } = await planningRepository()
	if (aliasedAgentDir) {
		const alias = join(cwd, "..", "agent-alias")
		symlinkSync(agentDir, alias, "dir")
		vi.stubEnv("PI_CODING_AGENT_DIR", alias)
	}
	const planner = createContext({ cwd, sessionManager: { getSessionId: () => "producer" } })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	const input = api.getHandler<InputEvent>("input")
	const dispatch = async (ctx = planner) => {
		const event: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(event, ctx)
		const requestId = event.headers["X-Request-Id"]
		if (!requestId) throw new Error("Request was not attributed")
		return requestId
	}
	await input({ type: "input", source: "interactive", text: "Explain unrelated.md" }, planner)
	const unrelated = await dispatch()
	await input({ type: "input", source: "interactive", text: "Plan docs/adr/new.md" }, planner)
	const research = await dispatch()
	const producer = await dispatch()
	const workId = getWorkId(planner)
	await api.getHandler("message_end")(
		{
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "save-plan", name: kind === "artifact" ? "write" : "submit_plan" }],
			},
		},
		planner,
	)
	let text: string
	if (kind === "artifact") {
		await createTrackedWriteTool(planner, "save-plan").execute("save-plan", {
			path: "docs/adr/new.md",
			content: "# Add export\n",
		})
		text = "Implement docs/adr/new.md"
	} else {
		const saved = savePlanMarkdown({ cwd, name: "owned-plan", planText: "# Add export\n", workId })
		appendWorkRecord(planner, { type: "plan", ...saved, requestId: producer })
		text =
			kind === "paste"
				? `Implement this:\n${readFileSync(saved.path, "utf8")}`
				: `Implement ${kind === "path" ? saved.path : saved.snapshotPath}`
		if (kind !== "path") rmSync(saved.path)
	}
	const original = readWorkRecords(agentDir).filter((row) => row.type === "request")
	const implementer = createContext({ cwd, sessionManager: { getSessionId: () => "consumer" } })
	return {
		cwd,
		agentDir,
		api,
		input,
		dispatch,
		planner,
		implementer,
		workId,
		text,
		unrelated,
		research,
		producer,
		original,
	}
}

it.each([
	"path",
	"snapshot",
	"paste",
	"artifact",
] as const)("automatically confirms only the producing input when continuing by %s, and respects revocation", async (kind) => {
	const flow = await recordedPlan(kind)
	await flow.input({ type: "input", source: "rpc", text: flow.text }, flow.implementer)
	const implementation = await flow.dispatch(flow.implementer)
	expect(getWorkId(flow.implementer)).toBe(flow.workId)
	let rows = readWorkRecords(flow.agentDir)
	const link = rows.find((row) => row.type === "work_link")
	expect(link).toMatchObject({
		sourceWorkId: flow.workId,
		targetWorkId: flow.workId,
		requestIds: [flow.research, flow.producer].sort(),
		evidence: { source: kind === "artifact" ? "named-artifact" : kind === "paste" ? "pasted-plan" : "saved-plan" },
	})
	expect(rows.filter((row) => row.type === "request" && row.requestId !== implementation)).toEqual(flow.original)
	await correctWorkLink(flow.implementer, `unlink ${link?.linkId}`)
	const next = createContext({ cwd: flow.cwd, sessionManager: { getSessionId: () => "later-consumer" } })
	await flow.input({ type: "input", source: "interactive", text: flow.text }, next)
	rows = readWorkRecords(flow.agentDir)
	expect(rows.filter((row) => row.type === "work_link")).toHaveLength(2)
})

it.each([
	"changed-content",
	"missing-request",
	"conflicting-producer",
	"missing-segment",
	"other-account",
	"other-work",
])("does not confirm historical planning charges with %s evidence", async (kind) => {
	const flow = await recordedPlan("path")
	const rows = readWorkRecords(flow.agentDir)
	const plan = rows.find((row) => row.type === "plan")
	const request = rows.find((row) => row.type === "request" && row.requestId === flow.producer)
	if (!plan || !request) throw new Error("Missing producing records")
	if (kind === "changed-content")
		writeFileSync(String(plan.path), `<!-- kimchi-work-id: ${flow.workId} -->\n# Changed\n`)
	if (kind === "missing-request") appendWorkRecord(flow.planner, { ...plan, requestId: undefined })
	if (kind === "conflicting-producer") appendWorkRecord(flow.planner, { ...plan, requestId: flow.unrelated })
	if (kind === "missing-segment") appendWorkRecord(flow.planner, { ...request, segment: undefined })
	if (kind === "other-account")
		appendWorkRecord(flow.planner, {
			...request,
			scope: {
				...createWorkScopeSnapshot(join(flow.cwd, ".git")).scope,
				account: { ...createWorkScopeSnapshot().scope.account, organizationId: "50000000-0000-4000-8000-000000000005" },
			},
		})
	if (kind === "other-work") appendWorkRecord(flow.implementer, request)
	await flow.input({ type: "input", source: "interactive", text: flow.text }, flow.implementer)
	expect(readWorkRecords(flow.agentDir).filter((row) => row.type === "work_link")).toEqual([])
})

it.each([
	"snapshot",
	"paste",
] as const)("does not confirm a producer after its retained %s was changed", async (kind) => {
	const flow = await recordedPlan(kind)
	const plan = readWorkRecords(flow.agentDir).find((row) => row.type === "plan")
	if (!plan || typeof plan.snapshotPath !== "string") throw new Error("Missing retained plan")
	const changed = `<!-- kimchi-work-id: ${flow.workId} -->\n# Replacement task\n`
	writeFileSync(plan.snapshotPath, changed)
	await flow.input(
		{ type: "input", source: "interactive", text: kind === "paste" ? changed : flow.text },
		flow.implementer,
	)
	// Keeping a work marker is not proof that the old request produced this new content.
	expect(readWorkRecords(flow.agentDir).filter((row) => row.type === "work_link")).toEqual([])
})
