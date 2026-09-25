import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { printMergedHelp } from "./help.js"

describe("printMergedHelp", () => {
	let logSpy: ReturnType<typeof vi.spyOn>
	let agentDir: string

	// Isolate package-command discovery from the real machine state.
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "kimchi-help-test-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
	})

	afterEach(() => {
		logSpy.mockRestore()
		vi.unstubAllEnvs()
		rmSync(agentDir, { recursive: true, force: true })
	})

	it("includes the multi-model, model, and provider flags", async () => {
		await printMergedHelp()
		const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
		expect(output).toContain("--multi-model")
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

	it("shows no package-commands section when none are installed", async () => {
		await printMergedHelp()
		const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
		expect(output).not.toContain("Package commands:")
	})

	it("lists installed package commands with their providing package", async () => {
		const pkgRoot = join(agentDir, "npm", "node_modules", "@fake/help")
		mkdirSync(join(pkgRoot, "dist"), { recursive: true })
		writeFileSync(
			join(pkgRoot, "package.json"),
			JSON.stringify({ name: "@fake/help", type: "module", kimchi: { commands: { hello: "./dist/hello.js" } } }),
		)
		writeFileSync(join(pkgRoot, "dist", "hello.js"), "export async function run() { return 0 }\n")
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@fake/help"] }))

		await printMergedHelp()

		const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n")
		expect(output).toContain("Package commands:")
		expect(output).toContain("kimchi hello")
		expect(output).toContain("(from @fake/help)")
	})
})
