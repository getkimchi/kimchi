import { afterEach, describe, expect, it, vi } from "vitest"
import { applyToolConfigs } from "./apply-tools.js"

const logInfoSpy = vi.hoisted(() => vi.fn())
const clackMock = vi.hoisted(() => {
	const spinnerInstance = { start: vi.fn(), stop: vi.fn() }
	return {
		spinner: vi.fn(() => spinnerInstance),
		spinnerInstance,
		log: { info: logInfoSpy, error: vi.fn(), warn: vi.fn() },
	}
})
vi.mock("@clack/prompts", () => ({
	log: {
		info: logInfoSpy,
		error: vi.fn(),
		warn: vi.fn(),
	},
	spinner: clackMock.spinner,
}))

import "../integrations/claude-code.js"
import "../integrations/cursor.js"
import type { ConfigScope } from "../config/scope.js"
import { TEST_MODELS } from "../integrations/__fixtures__/models.js"
import { byId } from "../integrations/registry.js"
import type { ConfigMode } from "./state.js"

describe("applyToolConfigs", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	// -------------------------------------------------------------------------
	// Override mode
	// -------------------------------------------------------------------------

	it("override mode calls tool.write() and logs launch guidance", async () => {
		const { applyToolConfigs } = await import("./apply-tools.js")
		const tool = byId("claudecode")
		if (!tool) throw new Error("claudecode not registered")
		const writeSpy = vi.spyOn(tool, "write").mockResolvedValue()

		const outcome = await applyToolConfigs({
			selectedTools: ["claudecode"],
			apiKey: "test-key",
			scope: "global" as ConfigScope,
			mode: "override" as ConfigMode,
			telemetryEnabled: false,
			models: TEST_MODELS,
		})

		expect(writeSpy).toHaveBeenCalledWith("global", "test-key", TEST_MODELS, {
			telemetryEnabled: false,
		})
		expect(outcome.successes).toContain("Claude Code")
		expect(outcome.failures).toEqual([])

		writeSpy.mockRestore()
	})

	// -------------------------------------------------------------------------
	// Inject mode
	// -------------------------------------------------------------------------

	it("inject mode skips write and logs kimchi launch guidance", async () => {
		const { applyToolConfigs } = await import("./apply-tools.js")
		const tool = byId("claudecode")
		if (!tool) throw new Error("claudecode not registered")
		const writeSpy = vi.spyOn(tool, "write")

		const outcome = await applyToolConfigs({
			selectedTools: ["claudecode"],
			apiKey: "test-key",
			scope: "global" as ConfigScope,
			mode: "inject" as ConfigMode,
			telemetryEnabled: false,
			models: TEST_MODELS,
		})

		expect(writeSpy).not.toHaveBeenCalled()
		expect(outcome.successes).toContain("Claude Code")
		expect(outcome.failures).toEqual([])
		expect(logInfoSpy).toHaveBeenCalledWith(expect.stringContaining("ready — launch via"))

		writeSpy.mockRestore()
	})

	// -------------------------------------------------------------------------
	// Failure handling
	// -------------------------------------------------------------------------

	it("collects failures without aborting other tools", async () => {
		const { applyToolConfigs } = await import("./apply-tools.js")
		const cursorTool = byId("cursor")
		if (!cursorTool) throw new Error("cursor not registered")
		const ccTool = byId("claudecode")
		if (!ccTool) throw new Error("claudecode not registered")

		vi.spyOn(cursorTool, "write").mockRejectedValue(new Error("disk full"))
		const ccWriteSpy = vi.spyOn(ccTool, "write").mockResolvedValue()

		const outcome = await applyToolConfigs({
			selectedTools: ["cursor", "claudecode"],
			apiKey: "test-key",
			scope: "global" as ConfigScope,
			mode: "override" as ConfigMode,
			telemetryEnabled: false,
			models: TEST_MODELS,
		})

		expect(outcome.successes).toContain("Claude Code")
		expect(outcome.failures).toEqual([{ id: "cursor", error: "disk full" }])

		ccWriteSpy.mockRestore()
	})

	it("skips the spinner for interactive-write tools", async () => {
		const tool = byId("claudecode")
		if (!tool) throw new Error("claudecode integration not registered")
		const writeSpy = vi.spyOn(tool, "write").mockResolvedValue()

		await applyToolConfigs({
			selectedTools: ["claudecode"],
			apiKey: "test-key",
			scope: "global" as ConfigScope,
			mode: "override" as ConfigMode,
			telemetryEnabled: false,
			models: TEST_MODELS,
		})
		const toolSpinnerStarts = clackMock.spinnerInstance.start.mock.calls.filter(
			(call: unknown[]) => typeof call[0] === "string" && call[0].includes("Claude Code"),
		)
		expect(toolSpinnerStarts).toEqual([])
		expect(clackMock.log.info).toHaveBeenCalledWith("Configuring Claude Code…")
		expect(clackMock.log.info).toHaveBeenCalledWith("Claude Code: configured")

		writeSpy.mockRestore()
	})

	it("uses the spinner for non-interactive tools", async () => {
		clackMock.spinnerInstance.start.mockClear()
		clackMock.spinnerInstance.stop.mockClear()
		clackMock.log.info.mockClear()
		clackMock.log.error.mockClear()
		clackMock.log.warn.mockClear()
		const tool = byId("cursor")
		if (!tool) throw new Error("cursor integration not registered")
		const writeSpy = vi.spyOn(tool, "write").mockResolvedValue()

		await applyToolConfigs({
			selectedTools: ["cursor"],
			apiKey: "test-key",
			scope: "global" as ConfigScope,
			mode: "override" as ConfigMode,
			telemetryEnabled: false,
			models: TEST_MODELS,
		})
		const toolSpinnerStarts = clackMock.spinnerInstance.start.mock.calls.filter(
			(call: unknown[]) => typeof call[0] === "string" && call[0].includes("Cursor"),
		)
		expect(toolSpinnerStarts).toEqual([["Configuring Cursor…"]])

		writeSpy.mockRestore()
	})
})
