import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
	BeforeProviderHeadersEvent,
	InputEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type * as Settings from "../../config/settings.js"
import { readConfigSetting, writeConfigSetting } from "../../config/settings.js"
import { savePlanMarkdown } from "../../shared/planning/plan-markdown.js"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createModel, createModelRegistry } from "../__mocks__/model-registry.js"
import { createWorkScopeSnapshot } from "../__mocks__/work-scope.js"
import { savedWorkSummary } from "../__mocks__/work-summary.js"
import * as prCostTelemetry from "../telemetry/pr-cost.js"
import {
	appendWorkRecord,
	createWorkAttributionExtension,
	getToolRequest,
	getWorkId,
	getWorkSegment,
	pinWorkContext,
	prepareProviderRequest,
	recordProviderRequest,
	recordProviderResponse,
	setWorkId,
	WORK_CHANGED_EVENT,
} from "../work-attribution.js"
import * as supervisor from "./reconcile-supervisor.js"
import type * as WorkAccounts from "./scope.js"
import { captureWorkAccount, captureWorkScope, readWorkScope } from "./scope.js"
import type * as Semantic from "./semantic.js"
import { classifyWorkIntent, rememberWorkIntent, WORK_MATCHING_DEADLINE_MS, workIntentPath } from "./semantic.js"
import { flushWorkSummaries, readWorkRecords } from "./summary.js"

vi.mock("../orchestration/model-roles.js", () => ({
	getModelRoles: () => ({ judge: ["selected/chat"] }),
	normalizeRoleModels: (value: string[]) => value,
}))
vi.mock("./semantic.js", async (original) => ({ ...(await original<typeof Semantic>()), classifyWorkIntent: vi.fn() }))
vi.mock("../../config/settings.js", async (original) => ({
	...(await original<typeof Settings>()),
	readConfigSetting: vi.fn(() => true),
	writeConfigSetting: vi.fn(),
}))
vi.mock("./scope.js", async (original) => ({
	...(await original<typeof WorkAccounts>()),
	captureWorkScope: vi.fn(),
	readWorkScope: vi.fn(),
	captureWorkAccount: vi.fn(async () => ({
		account: {
			apiUrl: "https://account.example/api",
			organizationId: "30000000-0000-4000-8000-000000000003",
			userId: "40000000-0000-4000-8000-000000000004",
		},
		isCurrent: () => true,
	})),
}))

let root: string
let cwd: string
const model = createModel("chat", "selected")
const modelRegistry = createModelRegistry([model])
const planned = "10000000-0000-4000-8000-000000000001"
const first = "Plan a CSV export that quotes commas and escapes double quotes."
beforeEach(() => {
	vi.mocked(readConfigSetting).mockReturnValue(true)
	vi.mocked(writeConfigSetting).mockReset()
	root = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-semantic-")))
	cwd = root
	const captured = createWorkScopeSnapshot(join(cwd, ".git"))
	vi.mocked(captureWorkScope).mockResolvedValue(captured)
	vi.mocked(readWorkScope).mockReturnValue(captured.scope)
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"))
	execFileSync("git", ["init", "-q", cwd])
	vi.mocked(classifyWorkIntent).mockReset()
	vi.spyOn(supervisor, "subscribeFileReconciliation").mockReturnValue(async () => {})
	vi.spyOn(supervisor, "subscribeCostReconciliation").mockReturnValue(async () => {})
})

it("does not load damaged private history or call the matcher when matching is disabled", async () => {
	await rememberWorkIntent(cwd, planned, first)
	writeFileSync(workIntentPath(planned), "unreadable private history")
	vi.mocked(readConfigSetting).mockReturnValue(false)
	const ctx = createContext({ cwd, model, modelRegistry })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	await api.getHandler<InputEvent>("input")({ type: "input", source: "rpc", text: "Implement the export" }, ctx)
	expect(classifyWorkIntent).not.toHaveBeenCalled()
	expect(ctx.ui.notify).not.toHaveBeenCalled()
})

it("turns matching off without waiting for an active model request to finish", async () => {
	const ctx = createCommandContext()
	vi.mocked(ctx.waitForIdle).mockImplementation(() => new Promise(() => {}))
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	const pending = api.getRegisteredCommand("work").handler("matching off", ctx)
	await vi.waitFor(() => expect(writeConfigSetting).toHaveBeenCalledWith("workSemanticMatching", false), {
		timeout: 100,
	})
	await pending
	expect(ctx.waitForIdle).not.toHaveBeenCalled()
})

it("keeps explicit plan continuation working when hosted matching is disabled", async () => {
	vi.mocked(readConfigSetting).mockReturnValue(false)
	const saved = savePlanMarkdown({ cwd, workId: planned, name: "export", planText: "# CSV export" })
	const ctx = createContext({ cwd, model, modelRegistry })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	await api.getHandler<InputEvent>("input")({ type: "input", source: "rpc", text: `Implement ${saved.path}` }, ctx)
	expect(getWorkId(ctx)).toBe(planned)
	expect(classifyWorkIntent).not.toHaveBeenCalled()
})

it("records only the final matching decision despite provisional segment writes", async () => {
	const metrics = vi.spyOn(prCostTelemetry, "trackPRCostMetric").mockImplementation(() => {})
	vi.mocked(readConfigSetting).mockReturnValue(false)
	const saved = savePlanMarkdown({ cwd, workId: planned, name: "export", planText: "# CSV export" })
	const ctx = createContext({ cwd, model, modelRegistry })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	await api.getHandler<InputEvent>("input")({ type: "input", source: "rpc", text: `Implement ${saved.path}` }, ctx)
	expect(metrics.mock.calls.filter(([metric]) => metric.kind === "matching")).toEqual([
		[{ kind: "matching", outcome: "explicit" }],
	])
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(root, { recursive: true, force: true })
})

it.each([
	"interactive",
	"rpc",
] as const)("adopts a paraphrased task for the first %s request and splits unrelated chat", async (source) => {
	await rememberWorkIntent(cwd, planned, first)
	const ctx = createContext({ cwd, model, modelRegistry, sessionManager: { getSessionId: () => "implement" } })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	const input = api.getHandler<InputEvent>("input")
	vi.mocked(classifyWorkIntent).mockResolvedValueOnce({ decision: "continue", workId: planned, model: "selected/chat" })
	await input({ type: "input", source, text: "Build the comma-separated download with quoted cells." }, ctx)
	// The turn does not wait for matching: its first request goes out first and is written once the work is chosen.
	const request: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
	await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(request, ctx)
	await vi.waitFor(() =>
		expect(readWorkRecords(join(root, "agent"))).toContainEqual(
			expect.objectContaining({ type: "request", requestId: request.headers["X-Request-Id"], workId: planned }),
		),
	)
	expect(getWorkId(ctx)).toBe(planned)
	vi.mocked(classifyWorkIntent).mockResolvedValueOnce({ decision: "new", model: "selected/chat" })
	await input({ type: "input", source, text: "Explain why the sky is blue." }, ctx)
	await vi.waitFor(() => expect(getWorkId(ctx)).not.toBe(planned))
	expect(
		readWorkRecords(join(root, "agent")).find((row) => row.requestId === request.headers["X-Request-Id"])?.workId,
	).toBe(planned)
	await flushWorkSummaries()
	const summary = savedWorkSummary(join(root, "agent"), planned)
	expect(summary.requests.find((row) => row.requestId === request.headers["X-Request-Id"])?.segment).toMatchObject({
		attribution: "inferred",
		reason: "model-continue",
	})
	expect(summary.continuations).toContainEqual(
		expect.objectContaining({
			source: "semantic",
			evidence: expect.objectContaining({
				decision: "continue",
				model: "selected/chat",
				promptVersion: 2,
				candidateWorkIds: [planned],
				segmentId: expect.any(String),
			}),
		}),
	)
	expect(JSON.stringify(summary)).not.toContain(first)
})

it("starts the turn before matching decides and writes its held request with the decided work", async () => {
	await rememberWorkIntent(cwd, planned, first)
	const ctx = createContext({ cwd, model, modelRegistry, sessionManager: { getSessionId: () => "async" } })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	let finish!: (value: Awaited<ReturnType<typeof classifyWorkIntent>>) => void
	vi.mocked(classifyWorkIntent).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
	// The input returns while the decision is still pending.
	await api.getHandler<InputEvent>("input")(
		{ type: "input", source: "interactive", text: "Build the comma-separated download with quoted cells." },
		ctx,
	)
	await vi.waitFor(() => expect(classifyWorkIntent).toHaveBeenCalledOnce())
	const request: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
	await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(request, ctx)
	const requestId = request.headers["X-Request-Id"]
	if (typeof requestId !== "string") throw new Error("Missing request ID")
	// The provider transport dispatches it, and the response arrives, before the decision.
	prepareProviderRequest(new Headers({ "X-Request-Id": requestId }), "", { bodyTags: [] })
	recordProviderResponse(requestId, new Response(null, { status: 200 }))
	// Its rows wait for the decision instead of naming a work the decision may replace.
	expect(readWorkRecords(join(root, "agent")).some((row) => row.requestId === requestId)).toBe(false)
	finish({ decision: "continue", workId: planned, model: "selected/chat" })
	await vi.waitFor(() =>
		expect(
			readWorkRecords(join(root, "agent"))
				.filter((row) => row.requestId === requestId)
				.map((row) => row.type),
		).toEqual(["request", "request_dispatch", "request_response"]),
	)
	const rows = readWorkRecords(join(root, "agent")).filter((row) => row.requestId === requestId)
	expect(rows.every((row) => row.workId === planned)).toBe(true)
	expect(rows[0].segment).toMatchObject({ attribution: "inferred", reason: "model-continue" })
})

it("runs a response's tools only after the pending decision, for the decided work", async () => {
	await rememberWorkIntent(cwd, planned, first)
	const ctx = createContext({ cwd, model, modelRegistry, sessionManager: { getSessionId: () => "tools" } })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	let finish!: (value: Awaited<ReturnType<typeof classifyWorkIntent>>) => void
	vi.mocked(classifyWorkIntent).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
	await api.getHandler<InputEvent>("input")(
		{ type: "input", source: "interactive", text: "Build the comma-separated download with quoted cells." },
		ctx,
	)
	const request: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
	await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(request, ctx)
	let ended = false
	const end = Promise.resolve(
		api.getHandler("message_end")(
			{
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "csv", name: "write" }],
				},
			},
			ctx,
		),
	).then(() => {
		ended = true
	})
	await new Promise((resolve) => setTimeout(resolve, 50))
	expect(ended).toBe(false)
	finish({ decision: "continue", workId: planned, model: "selected/chat" })
	await end
	expect(getToolRequest(ctx, "csv")).toEqual({ requestId: request.headers["X-Request-Id"], workId: planned })
})

it("settles a run only after its held requests are written with the decision", async () => {
	await rememberWorkIntent(cwd, planned, first)
	const ctx = createContext({ cwd, model, modelRegistry, sessionManager: { getSessionId: () => "settled" } })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	let finish!: (value: Awaited<ReturnType<typeof classifyWorkIntent>>) => void
	vi.mocked(classifyWorkIntent).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
	await api.getHandler<InputEvent>("input")(
		{ type: "input", source: "interactive", text: "Build the comma-separated download with quoted cells." },
		ctx,
	)
	const request: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
	await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(request, ctx)
	let settled = false
	const end = Promise.resolve(api.getHandler("agent_settled")({ type: "agent_settled" }, ctx)).then(() => {
		settled = true
	})
	await new Promise((resolve) => setTimeout(resolve, 50))
	expect(settled).toBe(false)
	finish({ decision: "continue", workId: planned, model: "selected/chat" })
	await end
	// Print mode and ACP prompts end here, so the reply's request is already written with its work.
	expect(readWorkRecords(join(root, "agent"))).toContainEqual(
		expect.objectContaining({ type: "request", requestId: request.headers["X-Request-Id"], workId: planned }),
	)
})

it("stops holding a response's tools at the matching deadline", async () => {
	await rememberWorkIntent(cwd, planned, first)
	const ctx = createContext({ cwd, model, modelRegistry, sessionManager: { getSessionId: () => "slow" } })
	const current = getWorkId(ctx)
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	vi.mocked(classifyWorkIntent).mockImplementationOnce(() => new Promise(() => {}))
	await api.getHandler<InputEvent>("input")({ type: "input", source: "interactive", text: "Add a CSV export" }, ctx)
	const request: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
	await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(request, ctx)
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
	try {
		const end = api.getHandler("message_end")(
			{
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "csv", name: "write" }],
				},
			},
			ctx,
		)
		await vi.advanceTimersByTimeAsync(WORK_MATCHING_DEADLINE_MS)
		await end
	} finally {
		vi.useRealTimers()
	}
	// The tools act for the work the request was sent with, as with matching off.
	expect(getToolRequest(ctx, "csv")).toEqual({ requestId: request.headers["X-Request-Id"], workId: current })
	expect(readWorkRecords(join(root, "agent"))).toContainEqual(
		expect.objectContaining({
			type: "request",
			requestId: request.headers["X-Request-Id"],
			workId: current,
			segment: expect.objectContaining({ attribution: "session", reason: "matching-pending" }),
		}),
	)
})

it("counts an input whose matching timed out as with matching off", async () => {
	await rememberWorkIntent(cwd, planned, first)
	const ctx = createContext({ cwd, model, modelRegistry, sessionManager: { getSessionId: () => "timeout" } })
	const current = getWorkId(ctx)
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	vi.mocked(classifyWorkIntent).mockResolvedValueOnce({ decision: "unknown", model: "selected/chat", cause: "timeout" })
	await api.getHandler<InputEvent>("input")({ type: "input", source: "interactive", text: "Add a CSV export" }, ctx)
	const request = recordProviderRequest(ctx, model)
	await vi.waitFor(() =>
		expect(readWorkRecords(join(root, "agent"))).toContainEqual(
			expect.objectContaining({
				type: "request",
				requestId: request.requestId,
				workId: current,
				segment: expect.objectContaining({ attribution: "session", reason: "matching-timeout" }),
			}),
		),
	)
})

it("keeps ambiguous input on its current work without selecting a candidate", async () => {
	await rememberWorkIntent(cwd, planned, first)
	const ctx = createContext({ cwd, model, modelRegistry, sessionManager: { getSessionId: () => "unclear" } })
	const current = getWorkId(ctx)
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	vi.mocked(classifyWorkIntent).mockResolvedValue({ decision: "unknown", model: "selected/chat" })
	await api.getHandler<InputEvent>("input")(
		{ type: "input", source: "interactive", text: "Which plan should I use?" },
		ctx,
	)
	expect(getWorkId(ctx)).toBe(current)
	const request = recordProviderRequest(ctx, model)
	await vi.waitFor(() =>
		expect(readWorkRecords(join(root, "agent"))).toContainEqual(
			expect.objectContaining({
				type: "request",
				requestId: request.requestId,
				workId: current,
				segment: expect.objectContaining({ attribution: "unknown", reason: "model-uncertain" }),
			}),
		),
	)
})

it("pins the input's segment for delayed side calls and hidden SDK retries", async () => {
	await rememberWorkIntent(cwd, planned, first)
	const ctx = createContext({ cwd, model, modelRegistry })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	const input = api.getHandler<InputEvent>("input")
	vi.mocked(classifyWorkIntent).mockResolvedValueOnce({ decision: "unknown", model: "selected/chat" })
	await input({ type: "input", source: "interactive", text: "Which task did you mean?" }, ctx)
	await vi.waitFor(() => expect(getWorkSegment(ctx)).toMatchObject({ reason: "model-uncertain" }))
	const originalWork = getWorkId(ctx)
	const pinned = pinWorkContext(ctx)
	const original = recordProviderRequest(ctx, model)
	prepareProviderRequest(new Headers({ "X-Request-Id": original.requestId }), "", { bodyTags: [] })
	vi.mocked(classifyWorkIntent).mockResolvedValueOnce({ decision: "new", model: "selected/chat" })
	await input({ type: "input", source: "interactive", text: "Explain the tides" }, ctx)
	const side = recordProviderRequest(pinned, model, originalWork)
	prepareProviderRequest(new Headers({ "X-Request-Id": original.requestId }), "", { bodyTags: [] })
	const records = readWorkRecords(join(root, "agent")).filter((row) => row.type === "request")
	const firstRequest = records.find((row) => row.requestId === original.requestId)
	expect(firstRequest?.segment).toMatchObject({ attribution: "unknown", reason: "model-uncertain" })
	expect(records.find((row) => row.requestId === side.requestId)?.segment).toEqual(firstRequest?.segment)
	expect(records.find((row) => row.parentRequestId === original.requestId)?.segment).toEqual(firstRequest?.segment)
})

it("keeps the existing work and request available when private metadata is damaged", async () => {
	await rememberWorkIntent(cwd, planned, first)
	writeFileSync(workIntentPath(planned), "private invalid JSON that must not appear in a warning")
	const ctx = createContext({ cwd, model, modelRegistry })
	const current = getWorkId(ctx)
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	await api.getHandler<InputEvent>("input")({ type: "input", source: "interactive", text: "Implement the export" }, ctx)
	const request: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
	await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(request, ctx)
	await vi.waitFor(() =>
		expect(readWorkRecords(join(root, "agent"))).toContainEqual(
			expect.objectContaining({
				type: "request",
				workId: current,
				requestId: request.headers["X-Request-Id"],
				segment: expect.objectContaining({ attribution: "session", reason: "matching-failed" }),
			}),
		),
	)
	expect(getWorkId(ctx)).toBe(current)
	expect(classifyWorkIntent).not.toHaveBeenCalled()
	// Optional matching failures stay in the debug log, so damaged metadata cannot warn on every prompt.
	expect(ctx.ui.notify).not.toHaveBeenCalled()
})

it("announces a work change from model matching once", async () => {
	await rememberWorkIntent(cwd, planned, first)
	const ctx = createContext({ cwd, model, modelRegistry, sessionManager: { getSessionId: () => "announce" } })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	const announced = vi.fn()
	vi.mocked(classifyWorkIntent).mockImplementationOnce(async () => {
		// Count only what the decision announces, after the input bound the session.
		api.api.events.on(WORK_CHANGED_EVENT, announced)
		return { decision: "continue", workId: planned, model: "selected/chat" }
	})
	await api.getHandler<InputEvent>("input")(
		{ type: "input", source: "interactive", text: "Build the comma-separated download with quoted cells." },
		ctx,
	)
	await vi.waitFor(() => expect(getWorkId(ctx)).toBe(planned))
	expect(announced).toHaveBeenCalledOnce()
})

it("matches a fresh session's input past 256 work directories without saved task text", async () => {
	for (let index = 0; index < 300; index++)
		mkdirSync(join(root, "agent", "work", `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`), {
			recursive: true,
		})
	await rememberWorkIntent(cwd, planned, first)
	const ctx = createContext({ cwd, model, modelRegistry, sessionManager: { getSessionId: () => "many-sessions" } })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	vi.mocked(classifyWorkIntent).mockResolvedValueOnce({ decision: "continue", workId: planned, model: "selected/chat" })
	await api.getHandler<InputEvent>("input")(
		{ type: "input", source: "interactive", text: "Build the comma-separated download with quoted cells." },
		ctx,
	)
	await vi.waitFor(() => expect(getWorkId(ctx)).toBe(planned))
	expect(vi.mocked(classifyWorkIntent).mock.calls[0][1].candidates.map((candidate) => candidate.workId)).toEqual([
		planned,
	])
})

it("reports a skipped matching limit in /work instead of on every prompt", async () => {
	await rememberWorkIntent(cwd, planned, first)
	savePlanMarkdown({
		cwd,
		workId: planned,
		name: "export",
		planText: `# CSV export\n${"Quote embedded commas.\n".repeat(800)}`,
	})
	const ctx = createContext({ cwd, model, modelRegistry })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	const input = api.getHandler<InputEvent>("input")
	for (const text of ["Add a CSV export", "Quote the commas too"]) {
		await input({ type: "input", source: "interactive", text }, ctx)
		// The input keeps the attribution it would have with matching off.
		await vi.waitFor(() =>
			expect(getWorkSegment(ctx)).toMatchObject({ attribution: "session", reason: "matching-limited" }),
		)
	}
	expect(classifyWorkIntent).not.toHaveBeenCalled()
	expect(ctx.ui.notify).not.toHaveBeenCalled()
	await api.getRegisteredCommand("work").handler("", { ...createCommandContext(), ...ctx })
	expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(
		expect.stringContaining("Work matching skipped the last input: a saved plan is larger than 16,000 bytes."),
		"info",
	)
})

it.each([
	"saved",
	"unowned-output",
	"conflicting",
])("keeps %s explicit plan references ahead of semantic inference", async (kind) => {
	await rememberWorkIntent(cwd, planned, first)
	const saved = savePlanMarkdown({ cwd, workId: planned, name: "export", planText: "# CSV export" })
	const other = savePlanMarkdown({ cwd, workId: randomUUID(), name: "other", planText: "# Other plan" })
	const ctx = createContext({ cwd, model, modelRegistry })
	const current = getWorkId(ctx)
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	await api.getHandler<InputEvent>("input")(
		{
			type: "input",
			source: "rpc",
			text: `Implement ${saved.path}${kind === "unowned-output" ? " and missing.md" : kind === "conflicting" ? ` and ${other.path}` : ""}`,
		},
		ctx,
	)
	expect(getWorkId(ctx)).toBe(kind === "conflicting" ? current : planned)
	expect(classifyWorkIntent).not.toHaveBeenCalled()
})

it.each(["child", "unattributed-child", "extension", "explicit"])("does not reclassify %s work", async (kind) => {
	await rememberWorkIntent(cwd, planned, first)
	const ctx = createContext({ cwd, model, modelRegistry })
	const api = createExtensionApi()
	createWorkAttributionExtension(kind === "child" ? planned : kind === "unattributed-child" ? null : undefined)(api.api)
	await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(
		{ type: "before_provider_headers", headers: {} },
		ctx,
	)
	if (kind === "explicit") await api.getRegisteredCommand("work").handler("new", { ...createCommandContext(), ...ctx })
	const current = getWorkId(ctx)
	await api.getHandler<InputEvent>("input")(
		{ type: "input", source: kind === "extension" ? "extension" : "interactive", text: "Implement CSV export" },
		ctx,
	)
	expect(getWorkId(ctx)).toBe(current)
	if (kind === "child") expect(current).toBe(planned)
	expect(classifyWorkIntent).not.toHaveBeenCalled()
})

it("can split an unrelated task after native output without adopting another prior work", async () => {
	await rememberWorkIntent(cwd, planned, first)
	const ctx = createContext({ cwd, model, modelRegistry })
	const current = getWorkId(ctx)
	await rememberWorkIntent(cwd, current, "Build a search box")
	appendWorkRecord(ctx, { type: "plan", path: "/search.md" })
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	vi.mocked(classifyWorkIntent).mockResolvedValue({ decision: "new", model: "selected/chat" })
	await api.getHandler<InputEvent>("input")({ type: "input", source: "interactive", text: "Explain tides" }, ctx)
	await vi.waitFor(() => expect(getWorkId(ctx)).not.toBe(current))
	expect(getWorkId(ctx)).not.toBe(planned)
	expect(vi.mocked(classifyWorkIntent).mock.calls[0][1]).toMatchObject({
		current: { workId: current },
		candidates: [],
	})
})

it.each([
	"new-input",
	"extension-input",
	"new-session",
	"changed-session-id",
	"work",
	"cwd",
	"shutdown",
	"output",
	"model",
	"matching-disabled",
	"account",
])("discards a semantic answer after %s changes its context", async (change) => {
	await rememberWorkIntent(cwd, planned, first)
	let accountCurrent = true
	if (change === "account") {
		const snapshot = await captureWorkAccount(cwd)
		if (!snapshot) throw new Error("Missing fixture account")
		vi.mocked(captureWorkAccount).mockResolvedValueOnce({ ...snapshot, isCurrent: () => accountCurrent })
	}
	let sessionId = "before"
	const ctx = createContext({ cwd, model, modelRegistry, sessionManager: { getSessionId: () => sessionId } })
	const current = getWorkId(ctx)
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	const input = api.getHandler<InputEvent>("input")
	let finish!: (value: Awaited<ReturnType<typeof classifyWorkIntent>>) => void
	vi.mocked(classifyWorkIntent).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = input({ type: "input", source: "interactive", text: "Implement CSV export" }, ctx)
	await vi.waitFor(() => expect(classifyWorkIntent).toHaveBeenCalledOnce())
	// The turn already sent a request while the answer was pending.
	const request: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
	await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(request, ctx)
	let expected = current
	if (change === "new-input") {
		vi.mocked(classifyWorkIntent).mockResolvedValueOnce({ decision: "unknown", model: "selected/chat" })
		await input({ type: "input", source: "rpc", text: "Never mind; explain waves" }, ctx)
	} else if (change === "extension-input") {
		await input({ type: "input", source: "extension", text: "Continue the existing task" }, ctx)
	} else if (change === "new-session") {
		const other = createContext({ cwd, model, modelRegistry, sessionManager: { getSessionId: () => "after" } })
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, other)
	} else if (change === "changed-session-id") {
		sessionId = "after"
		expected = getWorkId(ctx)
	} else if (change === "work") {
		expected = setWorkId(ctx)
	} else if (change === "cwd") {
		const other = join(root, "other")
		mkdirSync(other)
		execFileSync("git", ["init", "-q", other])
		ctx.cwd = other
	} else if (change === "shutdown") {
		await api.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
	} else if (change === "model") ctx.model = createModel("other", "selected")
	else if (change === "matching-disabled") vi.mocked(readConfigSetting).mockReturnValue(false)
	else if (change === "account") accountCurrent = false
	else appendWorkRecord(ctx, { type: "plan", path: "/actual-output.md" })
	finish({ decision: "continue", workId: planned, model: "selected/chat" })
	await pending
	// It is written with the work it was sent with, never with the discarded answer's.
	await vi.waitFor(() =>
		expect(readWorkRecords(join(root, "agent"))).toContainEqual(
			expect.objectContaining({ type: "request", requestId: request.headers["X-Request-Id"], workId: current }),
		),
	)
	expect(getWorkId(ctx)).toBe(expected)
	expect(readWorkRecords(join(root, "agent")).filter((row) => row.type === "work" && row.workId === planned)).toEqual(
		[],
	)
	if (["new-input", "extension-input", "new-session", "shutdown"].includes(change))
		expect(vi.mocked(classifyWorkIntent).mock.calls[0][2]?.aborted).toBe(true)
})
