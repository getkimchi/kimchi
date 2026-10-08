import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { INFRA_BREAKER_THRESHOLD_ENV } from "../../upstream-retry-patch.js"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import * as supervisor from "../work-attribution/reconcile-supervisor.js"
import { WORK_CHANGED_EVENT, WORK_STATE_REQUEST_EVENT, type WorkStateRequest } from "../work-attribution.js"
import { CI_VARIABLES } from "./automation.js"
import reportingExtension from "./index.js"
import * as queue from "./queue.js"
import { queueSnapshots, readReportingState, setReportingEnabled } from "./queue.js"
import { reconcileReporting } from "./worker.js"

vi.mock("../work-attribution/reconcile-supervisor.js", () => ({
	subscribeReportingReconciliation: vi.fn(),
	requestWorkReconciliation: vi.fn(),
}))
vi.mock("./worker.js", () => ({ reconcileReporting: vi.fn() }))
const mode = vi.hoisted(() => ({ acp: false }))
vi.mock("../../modes/acp/state.js", () => ({
	get IS_ACP_MODE() {
		return mode.acp
	},
}))
let directory: string
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "kimchi-reporting-extension-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", directory)
	vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
	// CI runners set these; each test opts into automation explicitly.
	for (const name of [...CI_VARIABLES, "KIMCHI_PR_COST_REPORTING", INFRA_BREAKER_THRESHOLD_ENV]) vi.stubEnv(name, "")
	vi.mocked(supervisor.subscribeReportingReconciliation).mockReturnValue(async () => {})
})
afterEach(() => {
	vi.clearAllMocks()
	vi.unstubAllEnvs()
	rmSync(directory, { recursive: true, force: true })
})

describe("optional PR reporting", () => {
	it("does not break session startup or turn completion when reporting state is damaged", async () => {
		await setReportingEnabled(directory, true)
		writeFileSync(join(directory, "pr-cost-reporting", "state.json"), "{broken")
		const ctx = createContext()
		const api = createExtensionApi()
		api.api.events.on(WORK_STATE_REQUEST_EVENT, (value) => {
			Object.assign(value as WorkStateRequest, { tracking: true, current: { workId: "test-work", ctx } })
		})
		reportingExtension(api.api)
		await expect(
			api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx),
		).resolves.toBeUndefined()
		await expect(Promise.resolve(api.getHandler("agent_end")({}, ctx))).resolves.toBeUndefined()
		expect(supervisor.requestWorkReconciliation).not.toHaveBeenCalled()
		await api.getHandler("session_shutdown")({}, ctx)
	})
	it("shows the default-on notice once across launches and says how to turn it off", async () => {
		const ctx = createContext()
		const notices: unknown[] = []
		for (let launch = 0; launch < 2; launch++) {
			const api = createExtensionApi()
			api.api.events.on(WORK_STATE_REQUEST_EVENT, (value) => {
				Object.assign(value as WorkStateRequest, { tracking: true, current: { workId: "test-work", ctx } })
			})
			reportingExtension(api.api)
			await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
			await api.getHandler("agent_end")({}, ctx)
			await api.getHandler("session_shutdown")({}, ctx)
			notices.push(...api.getAppendedEntries("pr-cost-reporting-notice"))
		}
		expect(notices).toEqual([expect.stringContaining("/pr-reporting off")])
		// Consecutive info notifications replace one another in the TUI.
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})
	it("shows the default-on notice in Studio after the first turn, once the client knows the session", async () => {
		mode.acp = true
		try {
			const ctx = createContext()
			const api = createExtensionApi()
			api.api.events.on(WORK_STATE_REQUEST_EVENT, (value) => {
				Object.assign(value as WorkStateRequest, { tracking: true, current: { workId: "test-work", ctx } })
			})
			reportingExtension(api.api)
			await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
			// Studio drops notifications for a session it has not registered yet.
			expect(ctx.ui.notify).not.toHaveBeenCalled()
			expect((await readReportingState(directory)).defaultNoticeShown).toBeUndefined()
			await api.getHandler("agent_end")({}, ctx)
			await api.getHandler("session_shutdown")({}, ctx)
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/pr-reporting off"), "info")
			expect(api.getAppendedEntries("pr-cost-reporting-notice")).toEqual([])
		} finally {
			mode.acp = false
		}
	})
	it("lets the turn finish while reporting state is still being read", async () => {
		await setReportingEnabled(directory, true)
		const state = await readReportingState(directory)
		const api = createExtensionApi()
		const ctx = createContext()
		api.api.events.on(WORK_STATE_REQUEST_EVENT, (value) => {
			Object.assign(value as WorkStateRequest, { tracking: true, current: { workId: "test-work", ctx } })
		})
		reportingExtension(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
		let release!: (value: queue.ReportingState) => void
		const blocked = new Promise<queue.ReportingState>((resolve) => {
			release = resolve
		})
		const read = vi.spyOn(queue, "readReportingState").mockReturnValueOnce(blocked)
		let finished = false
		const dispatched = Promise.resolve(api.getHandler("agent_end")({}, ctx)).then(() => {
			finished = true
		})
		try {
			await vi.waitFor(() => expect(finished).toBe(true), { timeout: 100 })
			expect(supervisor.requestWorkReconciliation).not.toHaveBeenCalled()
		} finally {
			release(state)
			await dispatched
			await api.getHandler("session_shutdown")({}, ctx)
			read.mockRestore()
		}
	})
	it.each(["telemetry-off", "explicit-on", "explicit-off"])("skips the default notice for %s", async (choice) => {
		if (choice === "telemetry-off") vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		else await setReportingEnabled(directory, choice === "explicit-on")
		const ctx = createContext()
		const api = createExtensionApi()
		api.api.events.on(WORK_STATE_REQUEST_EVENT, (value) => {
			Object.assign(value as WorkStateRequest, { tracking: true, current: { workId: "test-work", ctx } })
		})
		reportingExtension(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
		await api.getHandler("agent_end")({}, ctx)
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		expect(api.getAppendedEntries("pr-cost-reporting-notice")).toEqual([])
		if (choice !== "explicit-on") expect(supervisor.requestWorkReconciliation).not.toHaveBeenCalled()
		await api.getHandler("session_shutdown")({}, ctx)
	})
	it("cancels the old account context before switching to another project session", async () => {
		const api = createExtensionApi()
		let ctx = createContext({ cwd: "/first" })
		api.api.events.on(WORK_STATE_REQUEST_EVENT, (value) => {
			Object.assign(value as WorkStateRequest, { tracking: true, current: { workId: "test-work", ctx } })
		})
		const stop = vi.fn(async () => {})
		vi.mocked(supervisor.subscribeReportingReconciliation).mockReturnValue(stop)
		reportingExtension(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
		ctx = createContext({ cwd: "/other" })
		api.api.events.emit(WORK_CHANGED_EVENT, {})
		expect(stop).toHaveBeenCalledOnce()
		expect(supervisor.subscribeReportingReconciliation).toHaveBeenCalledTimes(2)
		await api.getHandler("session_shutdown")({}, ctx)
	})
	it("stays inactive when work tracking is absent or this is a child", async () => {
		const api = createExtensionApi()
		reportingExtension(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, createContext())
		expect(supervisor.subscribeReportingReconciliation).not.toHaveBeenCalled()
		expect(existsSync(join(directory, "pr-cost-reporting"))).toBe(false)
		await api.getHandler("agent_end")({}, createContext())
		expect(supervisor.requestWorkReconciliation).not.toHaveBeenCalled()
	})
	it("starts main reporting by default and refreshes immediately when enabled or a turn ends", async () => {
		const api = createExtensionApi()
		const ctx = createContext()
		api.api.events.on(WORK_STATE_REQUEST_EVENT, (value) => {
			Object.assign(value as WorkStateRequest, { tracking: true, current: { workId: "test-work", ctx } })
		})
		const stop = vi.fn(async () => {})
		vi.mocked(supervisor.subscribeReportingReconciliation).mockReturnValue(stop)
		reportingExtension(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
		expect(supervisor.subscribeReportingReconciliation).toHaveBeenCalledOnce()
		expect((await readReportingState(directory)).enabled).toBe(true)
		const command = api.getRegisteredCommand("pr-reporting")
		const commandCtx = createCommandContext()
		await command.handler("on", commandCtx)
		expect(supervisor.requestWorkReconciliation).toHaveBeenCalledOnce()
		expect((await readReportingState(directory)).enabled).toBe(true)
		expect(commandCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("request and billing IDs"), "info")
		await api.getHandler("agent_end")({}, ctx)
		await vi.waitFor(() => expect(supervisor.requestWorkReconciliation).toHaveBeenCalledTimes(2))
		await command.handler("off", commandCtx)
		expect((await readReportingState(directory)).enabled).toBe(false)
		await api.getHandler("session_shutdown")({}, ctx)
		expect(stop).toHaveBeenCalledOnce()
		await api.getHandler("agent_end")({}, ctx)
		expect(supervisor.requestWorkReconciliation).toHaveBeenCalledTimes(2)
	})
	it.each([
		["tui", true],
		["rpc", true],
		["print", false],
		["json", false],
	] as const)("keeps attributing in a %s session and uploads only when interactive", async (mode, deliver) => {
		const ctx = createContext({ mode })
		const api = createExtensionApi()
		api.api.events.on(WORK_STATE_REQUEST_EVENT, (value) => {
			Object.assign(value as WorkStateRequest, { tracking: true, current: { workId: "test-work", ctx } })
		})
		reportingExtension(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
		const [[report]] = vi.mocked(supervisor.subscribeReportingReconciliation).mock.calls
		const signal = new AbortController().signal
		await report(directory, signal, () => {})
		expect(reconcileReporting).toHaveBeenCalledWith(directory, ctx.cwd, signal, expect.any(Function), deliver)
		const commandCtx = { ...createCommandContext(), mode }
		await api.getRegisteredCommand("pr-reporting").handler("status", commandCtx)
		const [[text]] = vi.mocked(commandCtx.ui.notify).mock.calls
		if (deliver) expect(text).not.toContain("Uploads are skipped")
		else
			expect(text).toContain(
				`Uploads are skipped in this session: non-interactive ${mode === "json" ? "JSON" : "print"} mode. Local attribution continues.`,
			)
		await api.getHandler("session_shutdown")({}, ctx)
	})
	it("shows that a CI session does not upload while reporting stays on", async () => {
		vi.stubEnv("GITHUB_ACTIONS", "true")
		const api = createExtensionApi()
		reportingExtension(api.api)
		const commandCtx = createCommandContext()
		await api.getRegisteredCommand("pr-reporting").handler("status", commandCtx)
		expect(commandCtx.ui.notify).toHaveBeenCalledWith(
			[
				"PR reporting: on (SaaS default)",
				"Uploads are skipped in this session: CI environment (GITHUB_ACTIONS). Local attribution continues.",
				"Queued repositories: 0",
				"Acknowledged repositories: 0",
			].join("\n"),
			"info",
		)
	})
	it.each([false, true])("warns once that a repository is partially reported (Studio=%s)", async (acp) => {
		mode.acp = acp
		try {
			await setReportingEnabled(directory, true)
			await queueSnapshots(directory, [
				{
					account: {
						apiUrl: "https://api.example",
						organizationId: "11111111-1111-4111-8111-111111111111",
						userId: "22222222-2222-4222-8222-222222222222",
					},
					content: {
						repository: { provider: "github", host: "github.com", id: "42", name: "owner/repo" },
						pullRequests: [],
						requests: [],
						coverage: { observedRequests: 0, unpricedRequests: 0, historyComplete: false, trimmedRequests: 3 },
					},
				},
			])
			const text = "PR costs for owner/repo are partially reported: limit reached. See /pr-reporting status."
			const ctx = createContext()
			for (let launch = 0; launch < 2; launch++) {
				const api = createExtensionApi()
				api.api.events.on(WORK_STATE_REQUEST_EVENT, (value) => {
					Object.assign(value as WorkStateRequest, { tracking: true, current: { workId: "test-work", ctx } })
				})
				reportingExtension(api.api)
				await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
				// Studio drops notifications for a session it has not registered yet.
				if (acp && launch === 0) expect(ctx.ui.notify).not.toHaveBeenCalled()
				await api.getHandler("agent_end")({}, ctx)
				await api.getHandler("session_shutdown")({}, ctx)
			}
			expect(vi.mocked(ctx.ui.notify).mock.calls.filter(([, level]) => level === "warning")).toEqual([
				[text, "warning"],
			])
		} finally {
			mode.acp = false
		}
	})
})
