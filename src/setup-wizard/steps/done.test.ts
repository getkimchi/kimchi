import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TEST_MODELS } from "../../integrations/__fixtures__/models.js"
import "../../integrations/claude-code.js"
import { byId } from "../../integrations/registry.js"
import * as modelsModule from "../../models.js"
import type { WizardState } from "../state.js"
import { runDoneStep } from "./done.js"

const installRtkMock = vi.hoisted(() => vi.fn())

vi.mock("../../resources/rtk-install.js", () => ({
	installRtk: installRtkMock,
}))

describe("runDoneStep", () => {
	let tmpHome: string
	let prevHome: string | undefined
	let prevShell: string | undefined

	beforeEach(() => {
		// runDoneStep calls exportEnvToShellProfile, which writes to $HOME's
		// shell profile. Redirect HOME to a scratch dir so we don't append
		// to the test runner's real .zshrc / .bashrc.
		tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "done-step-test-")))
		prevHome = process.env.HOME
		prevShell = process.env.SHELL
		process.env.HOME = tmpHome
		// Pin shell so detection is deterministic across CI environments.
		process.env.SHELL = "/bin/zsh"

		// @clack/prompts writes its UI to stdout; silence it so the test
		// runner output stays focused on assertions.
		vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		vi.spyOn(console, "warn").mockImplementation(() => {})

		// Mock updateModelsConfig so we don't hit the real network.
		vi.spyOn(modelsModule, "updateModelsConfig").mockResolvedValue({
			models: TEST_MODELS as import("../../models.js").ModelMetadata[],
		})
		installRtkMock.mockReset()
		installRtkMock.mockResolvedValue({
			version: "v1.2.3",
			binaryPath: "/tmp/kimchi-test/rtk",
			linkPath: "/tmp/kimchi-test/bin/rtk",
		})
	})

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
		if (prevHome === undefined) delete process.env.HOME
		else process.env.HOME = prevHome
		// biome-ignore lint/performance/noDelete: same reason as HOME above.
		if (prevShell === undefined) delete process.env.SHELL
		else process.env.SHELL = prevShell
		rmSync(tmpHome, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	function baseState(): WizardState {
		return {
			apiKey: "test-key",
			mode: "override",
			scope: "global",
			selectedTools: ["claudecode"],
			telemetryEnabled: true,
			cancelled: false,
			back: false,
		}
	}

	function getClaudeCodeTool() {
		const tool = byId("claudecode")
		if (!tool) throw new Error("claudecode integration not registered — wiring bug")
		return tool
	}

	it("override mode invokes the integration writer with models from the API", async () => {
		const tool = getClaudeCodeTool()
		const writeSpy = vi.spyOn(tool, "write").mockResolvedValue()

		const outcome = await runDoneStep(baseState())
		// write is called with (scope, apiKey, models, options)
		expect(writeSpy).toHaveBeenCalledWith("global", "test-key", TEST_MODELS, { telemetryEnabled: true })
		expect(outcome.successes).toEqual(["Claude Code"])
		expect(outcome.failures).toEqual([])

		writeSpy.mockRestore()
	})

	it("inject mode skips the writer entirely", async () => {
		const tool = getClaudeCodeTool()
		const writeSpy = vi.spyOn(tool, "write").mockResolvedValue()

		const state = baseState()
		state.mode = "inject"
		const outcome = await runDoneStep(state)

		expect(writeSpy).not.toHaveBeenCalled()
		// Tool still listed as a "success" so the user knows it's wired —
		// just via the launcher rather than a config file.
		expect(outcome.successes).toEqual(["Claude Code"])
		expect(outcome.failures).toEqual([])

		writeSpy.mockRestore()
	})

	it("ensures RTK when setup requests it", async () => {
		const tool = getClaudeCodeTool()
		const writeSpy = vi.spyOn(tool, "write").mockResolvedValue()
		const state = baseState()
		state.installRtk = true

		const outcome = await runDoneStep(state)

		expect(installRtkMock).toHaveBeenCalledTimes(1)
		expect(outcome.rtkInstalled).toBe(true)
		expect(outcome.failures).toEqual([])

		writeSpy.mockRestore()
	})

	it("treats RTK install failure as a setup warning", async () => {
		const tool = getClaudeCodeTool()
		const writeSpy = vi.spyOn(tool, "write").mockResolvedValue()
		installRtkMock.mockRejectedValueOnce(new Error("GitHub rate limited"))
		const state = baseState()
		state.installRtk = true

		const outcome = await runDoneStep(state)

		expect(outcome.successes).toEqual(["Claude Code"])
		expect(outcome.failures).toEqual([])
		expect(outcome.warnings).toEqual([{ id: "rtk", error: "GitHub rate limited" }])

		writeSpy.mockRestore()
	})

	it("collects failures rather than aborting on a single broken writer", async () => {
		const tool = getClaudeCodeTool()
		const writeSpy = vi.spyOn(tool, "write").mockRejectedValue(new Error("disk full"))

		const outcome = await runDoneStep(baseState())
		expect(outcome.successes).toEqual([])
		expect(outcome.failures).toEqual([{ id: "claudecode", error: "disk full" }])

		writeSpy.mockRestore()
	})

	it("returns failures for unregistered tool ids without throwing", async () => {
		const state = baseState()
		// Cast through unknown to bypass the ToolId compile check — production
		// callers only ever pass valid ids, but defensive code in the step
		// shouldn't blow up if a future caller misuses this entry point.
		state.selectedTools = ["never-registered" as unknown as "claudecode"]
		const outcome = await runDoneStep(state)
		expect(outcome.successes).toEqual([])
		expect(outcome.failures[0]?.id).toBe("never-registered")
	})

	it("exports KIMCHI_API_KEY to the user's shell profile", async () => {
		const tool = getClaudeCodeTool()
		const writeSpy = vi.spyOn(tool, "write").mockResolvedValue()

		await runDoneStep(baseState())
		const { readFileSync } = await import("node:fs")
		const zshrc = readFileSync(join(tmpHome, ".zshrc"), "utf-8")
		expect(zshrc).toContain("export KIMCHI_API_KEY=test-key")

		writeSpy.mockRestore()
	})
})
