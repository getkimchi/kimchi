import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { INFRA_BREAKER_THRESHOLD_ENV } from "../../upstream-retry-patch.js"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { CI_VARIABLES } from "./automation.js"
import { prReportingHeaderValue, prReportingStatePath, setPRReportingSessionMode } from "./consent.js"
import reportingExtension from "./index.js"

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
})
afterEach(() => {
	mode.acp = false
	setPRReportingSessionMode(undefined)
	vi.clearAllMocks()
	vi.unstubAllEnvs()
	rmSync(directory, { recursive: true, force: true })
})

const saved = () => JSON.parse(readFileSync(prReportingStatePath(directory), "utf8"))
function save(state: unknown): void {
	mkdirSync(dirname(prReportingStatePath(directory)), { recursive: true })
	writeFileSync(prReportingStatePath(directory), typeof state === "string" ? state : JSON.stringify(state))
}

/** One launch: start a session, finish a turn and shut down. */
async function launch(ctx = createContext()) {
	const api = createExtensionApi()
	reportingExtension(api.api)
	await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
	await api.getHandler("agent_end")({}, ctx)
	await api.getHandler("session_shutdown")({}, ctx)
	return api
}

async function command(args: string, commandCtx = createCommandContext()) {
	const api = createExtensionApi()
	reportingExtension(api.api)
	await api.getRegisteredCommand("pr-reporting").handler(args, commandCtx)
	return vi.mocked(commandCtx.ui.notify).mock.calls
}

describe("default-on notice", () => {
	it("says once across launches that the gateway reports PR costs and how to turn it off", async () => {
		const ctx = createContext()
		const notices: unknown[] = []
		for (let count = 0; count < 2; count++)
			notices.push(...(await launch(ctx)).getAppendedEntries("pr-cost-reporting-notice"))
		expect(notices).toEqual([
			"PR costs are reported to your account by the Kimchi gateway. Turn off with /pr-reporting off.",
		])
		expect(saved()).toMatchObject({ followsTelemetry: true, defaultNoticeShown: true })
		// Consecutive info notifications replace one another in the TUI.
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("shows the notice in Studio after the first turn, once the client knows the session", async () => {
		mode.acp = true
		const ctx = createContext()
		const api = createExtensionApi()
		reportingExtension(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
		// Studio drops notifications for a session it has not registered yet.
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		await api.getHandler("agent_end")({}, ctx)
		await api.getHandler("session_shutdown")({}, ctx)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/pr-reporting off"), "info")
		expect(api.getAppendedEntries("pr-cost-reporting-notice")).toEqual([])
	})

	it.each([
		"telemetry-off",
		"explicit-on",
		"explicit-off",
		"ci",
		"print",
	])("skips the notice when the default does not report: %s", async (situation) => {
		if (situation === "telemetry-off") vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		if (situation.startsWith("explicit")) save({ version: 1, enabled: situation === "explicit-on" })
		if (situation === "ci") vi.stubEnv("GITHUB_ACTIONS", "true")
		const ctx = createContext(situation === "print" ? { mode: "print" } : undefined)
		const api = await launch(ctx)
		expect(api.getAppendedEntries("pr-cost-reporting-notice")).toEqual([])
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("starts sessions and finishes turns when the saved state is damaged", async () => {
		save("{broken")
		const ctx = createContext()
		const api = await launch(ctx)
		expect(api.getAppendedEntries("pr-cost-reporting-notice")).toEqual([])
		expect(prReportingHeaderValue(directory)).toBe("off")
	})
})

describe("/pr-reporting", () => {
	it("turns reporting on against a disabled SaaS default and keeps fields an older Kimchi saved", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		save({ version: 1, enabled: false, followsTelemetry: true, producerId: "older-producer", entries: {} })
		expect(prReportingHeaderValue(directory)).toBe("off")
		const [[text, level]] = await command("on")
		expect(level).toBe("info")
		expect(text).toContain("The Kimchi gateway reports PR costs to your account")
		expect(saved()).toEqual({ version: 1, enabled: true, producerId: "older-producer", entries: {} })
		expect(prReportingHeaderValue(directory)).toBe("proxy")
	})

	it("turns reporting off against an enabled SaaS default", async () => {
		const [[text]] = await command("off")
		expect(text).toContain("Kimchi asks the gateway not to report PR costs")
		expect(saved()).toEqual({ version: 1, enabled: false })
		expect(prReportingHeaderValue(directory)).toBe("off")
		const [[status]] = await command("status")
		expect(status).toBe(["PR reporting   Disabled (explicit choice)", "This session   Not reported"].join("\n"))
	})

	it("says when turning reporting on cannot cover this process", async () => {
		vi.stubEnv("GITHUB_ACTIONS", "true")
		const [[text]] = await command("on")
		expect(text).toContain("This session is not reported: CI environment (GITHUB_ACTIONS).")
		expect(prReportingHeaderValue(directory)).toBe("off")
	})

	it.each(["", "status"])("shows the status for %j", async (args) => {
		expect(await command(args)).toEqual([
			[["PR reporting   Enabled (SaaS default)", "This session   Reported by the Kimchi gateway"].join("\n"), "info"],
		])
	})

	it.each(["print", "json"] as const)("names a %s session as not reported", async (sessionMode) => {
		const ctx = createContext({ mode: sessionMode })
		const api = createExtensionApi()
		reportingExtension(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
		const commandCtx = createCommandContext()
		await api.getRegisteredCommand("pr-reporting").handler("status", commandCtx)
		expect(commandCtx.ui.notify).toHaveBeenCalledWith(
			[
				"PR reporting   Enabled (SaaS default)",
				"This session   Not reported",
				`               Reason: non-interactive ${sessionMode === "json" ? "JSON" : "print"} mode`,
			].join("\n"),
			"info",
		)
	})

	it("keeps a damaged saved state and warns instead of guessing", async () => {
		save("{broken")
		for (const args of ["on", "status"])
			expect(await command(args)).toEqual([["PR reporting state could not be saved or read.", "warning"]])
		expect(readFileSync(prReportingStatePath(directory), "utf8")).toBe("{broken")
	})

	it("explains its arguments", async () => {
		expect(await command("maybe")).toEqual([["Usage: /pr-reporting on|off|status", "info"]])
	})

	it("suggests on, off and status after /pr-reporting and narrows them as the user types", async () => {
		const api = createExtensionApi()
		reportingExtension(api.api)
		const { getArgumentCompletions } = api.getRegisteredCommand("pr-reporting")
		const values = async (prefix: string) =>
			(await getArgumentCompletions?.(prefix))?.map((item) => [item.value, item.label]) ?? []
		expect(await getArgumentCompletions?.("")).toEqual(
			["on", "off", "status"].map((value) => ({ value, label: value, description: expect.any(String) })),
		)
		expect(await values("o")).toEqual([
			["on", "on"],
			["off", "off"],
		])
		expect(await values("OF")).toEqual([["off", "off"]])
		expect(await values(" st")).toEqual([["status", "status"]])
		expect(await values("x")).toEqual([])
	})
})
