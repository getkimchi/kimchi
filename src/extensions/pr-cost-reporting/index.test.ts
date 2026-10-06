import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import * as supervisor from "../work-attribution/reconcile-supervisor.js"
import { WORK_CHANGED_EVENT, WORK_STATE_REQUEST_EVENT, type WorkStateRequest } from "../work-attribution.js"
import reportingExtension from "./index.js"
import { readReportingState, setReportingEnabled } from "./queue.js"

vi.mock("../work-attribution/reconcile-supervisor.js", () => ({
	subscribeReportingReconciliation: vi.fn(),
	requestWorkReconciliation: vi.fn(),
}))
let directory: string
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "kimchi-reporting-extension-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", directory)
	vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
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
		await expect(api.getHandler("agent_end")({}, ctx)).resolves.toBeUndefined()
		expect(supervisor.requestWorkReconciliation).not.toHaveBeenCalled()
		await api.getHandler("session_shutdown")({}, ctx)
	})
	it("shows the default-on notice once across launches and says how to turn it off", async () => {
		const ctx = createContext()
		for (let launch = 0; launch < 2; launch++) {
			const api = createExtensionApi()
			api.api.events.on(WORK_STATE_REQUEST_EVENT, (value) => {
				Object.assign(value as WorkStateRequest, { tracking: true, current: { workId: "test-work", ctx } })
			})
			reportingExtension(api.api)
			await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
			await api.getHandler("agent_end")({}, ctx)
			await api.getHandler("session_shutdown")({}, ctx)
		}
		expect(ctx.ui.notify).toHaveBeenCalledOnce()
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/pr-reporting off"), "info")
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
		expect(supervisor.requestWorkReconciliation).toHaveBeenCalledTimes(2)
		await command.handler("off", commandCtx)
		expect((await readReportingState(directory)).enabled).toBe(false)
		await api.getHandler("session_shutdown")({}, ctx)
		expect(stop).toHaveBeenCalledOnce()
		await api.getHandler("agent_end")({}, ctx)
		expect(supervisor.requestWorkReconciliation).toHaveBeenCalledTimes(2)
	})
})
