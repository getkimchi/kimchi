import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { setToolGateSession } from "../../settings-watcher.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { CODEMODE_SELECTION_GUIDANCE, createGuidedCodemodeExtension } from "./guidance.js"

function codemodeDescription(): string | undefined {
	const mock = createExtensionApi()
	createGuidedCodemodeExtension()(mock.api)
	const codemode = mock.getRegisteredTool("codemode")
	// Registered default-active: kimchi owns the default, independent of
	// ferment's idle-profile snapshot (which a disabled ferment resource
	// never applies).
	expect(codemode.defaultActive).toBe(true)
	return codemode.prepareLoadout?.({
		declared: [],
		callable: [],
		registered: [],
		getExposure: () => "direct",
		getNamespace: () => undefined,
		getPromptGuidelines: () => [],
	})?.descriptions?.codemode
}

it("prepends the selection rule to Pi's generated codemode description", () => {
	const description = codemodeDescription()
	expect(description?.startsWith(`${CODEMODE_SELECTION_GUIDANCE}\n\n`)).toBe(true)
	expect(description).toContain("Run JavaScript that calls other tools")
})

it("steers filtering and mechanical chains to codemode, independent full-result calls to direct tools", () => {
	expect(CODEMODE_SELECTION_GUIDANCE).toContain("filter large results")
	expect(CODEMODE_SELECTION_GUIDANCE).toContain("chain calls whose arguments depend on earlier results")
	expect(CODEMODE_SELECTION_GUIDANCE).toContain("call tools directly in one turn")
	// No worked example script: it cost ~250 tokens per request without moving adoption.
	expect(codemodeDescription()).not.toContain("const hits")
	// A chaining script has to parse grep output; the format is stated instead.
	expect(CODEMODE_SELECTION_GUIDANCE).toContain("`path:line: text`")
})

it("asks for a purpose line in every script, not as an optional extra", () => {
	expect(CODEMODE_SELECTION_GUIDANCE).toContain(
		"Start every script with a purpose line: `// @description: <short purpose>` (one line, maximum 120 characters).",
	)
	expect(CODEMODE_SELECTION_GUIDANCE).not.toContain("Optional purpose")
})

it("places required @options before the purpose in model-facing guidance", () => {
	expect(CODEMODE_SELECTION_GUIDANCE).toContain(
		"Source order: `@options` when used → `// @description: <short purpose>` → executable code.",
	)
})

describe("defaultTools exclusion (session_start)", () => {
	let projectDir: string

	function seedProjectSettings(settings: Record<string, unknown>): void {
		mkdirSync(join(projectDir, ".pi"), { recursive: true })
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(settings))
		setToolGateSession(projectDir, true)
	}

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "kimchi-codemode-gate-"))
	})

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true })
		// Repoint the gate at a directory with no project layer so later
		// isDefaultToolEnabled lookups in this worker read global settings only.
		setToolGateSession(join(tmpdir(), "codemode-gate-reset"), false)
	})

	it("deactivates the registration-activated tool when defaultTools excludes it", async () => {
		seedProjectSettings({ defaultTools: ["-codemode"] })
		const { api, emit } = createExtensionApi()
		createGuidedCodemodeExtension()(api)
		// Pi force-activates extension tools past the defaultTools filter, so
		// the tool is active after registration; the session_start pass must
		// honor the `-codemode` exclusion.
		expect(api.getActiveTools()).toContain("codemode")
		await emit("session_start", {}, {} as never)
		expect(api.getActiveTools()).not.toContain("codemode")
	})

	it("keeps the tool active when defaultTools names it", async () => {
		seedProjectSettings({ defaultTools: ["+codemode"] })
		const { api, emit } = createExtensionApi()
		createGuidedCodemodeExtension()(api)
		await emit("session_start", {}, {} as never)
		expect(api.getActiveTools()).toContain("codemode")
	})
})
