import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest"
import { printMergedHelp } from "./help.js"
import { installFakePackage, setupFakeAgentDir, teardownFakeAgentDir } from "./test-helpers.js"

describe("printMergedHelp", () => {
	let logSpy: MockInstance<(...args: unknown[]) => unknown>
	let agentDir: string

	// Isolate package-command discovery from the real machine state.
	beforeEach(() => {
		agentDir = setupFakeAgentDir()
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
	})

	afterEach(() => {
		logSpy.mockRestore()
		vi.unstubAllEnvs()
		teardownFakeAgentDir(agentDir)
	})

	it("includes the model and provider flags, and no multi-model flag", async () => {
		await printMergedHelp()
		const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
		expect(output).not.toContain("--multi-model")
		expect(output).toContain("--model <pattern>")
		expect(output).toContain("--provider <name>")
	})

	it("includes boolean flags with short aliases", async () => {
		await printMergedHelp()
		const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
		expect(output).toContain("--print, -p")
		expect(output).toContain("--help, -h")
	})

	it("includes optional-string flags with bracketed placeholders", async () => {
		await printMergedHelp()
		const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
		expect(output).toContain("--resume, -r [id]")
		expect(output).toContain("--list-models [search]")
	})

	it("includes the Codex example with setup-tools guidance", async () => {
		await printMergedHelp()
		const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
		expect(output).toContain("kimchi codex")
		expect(output).toContain("setup-tools first")
	})

	it("omits hidden catalog flags and keeps visible extension booleans", async () => {
		await printMergedHelp()
		const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
		expect(output).toContain("--ferment-oneshot")
		expect(output).toContain("--init-git")
		expect(output).not.toContain("--debug-prompts")
		expect(output).not.toMatch(/--memory\b/)
	})

	it("shows no package-commands section when none are installed", async () => {
		await printMergedHelp()
		const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
		expect(output).not.toContain("Package commands:")
	})

	it("lists installed package commands with their providing package", async () => {
		installFakePackage(agentDir, "@fake/help", { hello: "./dist/hello.js" })

		await printMergedHelp()

		const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
		expect(output).toContain("Package commands:")
		expect(output).toContain("kimchi hello")
		expect(output).toContain("(from @fake/help)")
	})
})
