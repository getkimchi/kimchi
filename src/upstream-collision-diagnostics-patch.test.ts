import { DefaultResourceLoader, type ResourceDiagnostic } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installCollisionDiagnosticsPatch } from "./upstream-collision-diagnostics-patch.js"

const { getParsedCliArgs } = vi.hoisted(() => ({ getParsedCliArgs: vi.fn() }))
vi.mock("./cli-args.js", () => ({ getParsedCliArgs }))

const DIAGNOSTIC_SINKS = [
	["updateSkillsFromPaths", "skillDiagnostics"],
	["updatePromptsFromPaths", "promptDiagnostics"],
	["updateThemesFromPaths", "themeDiagnostics"],
] as const

const collision: ResourceDiagnostic = {
	type: "collision",
	message: 'skill "duplicated" collides',
	collision: {
		resourceType: "skill",
		name: "duplicated",
		winnerPath: "/winner/SKILL.md",
		loserPath: "/loser/SKILL.md",
	},
}
const warning: ResourceDiagnostic = {
	type: "warning",
	message: "description exceeds 1024 characters (1273)",
	path: "/tmp/skill/SKILL.md",
}
const error: ResourceDiagnostic = {
	type: "error",
	message: "resource failed to load",
	path: "/tmp/broken/SKILL.md",
}

// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype adapter
const prototype = DefaultResourceLoader.prototype as any
const originalMethods = new Map(DIAGNOSTIC_SINKS.map(([method]) => [method, prototype[method]]))

let quietStartup = true
function setVerbose(verbose: boolean): void {
	getParsedCliArgs.mockReturnValue({ options: { verbose }, positionals: [] })
}

function resetPrototype(): void {
	for (const [method] of DIAGNOSTIC_SINKS) {
		prototype[method] = originalMethods.get(method)
	}
	prototype.__kimchiCollisionDiagnosticsPatchApplied = false
}

function runPatchOverStub(
	method: string,
	field: string,
	diagnostics: ResourceDiagnostic[],
	returnValue: unknown = undefined,
): { returned: unknown; diagnostics: unknown } {
	prototype[method] = function stubInner(this: Record<string, unknown>) {
		this[field] = diagnostics
		return returnValue
	}
	prototype.__kimchiCollisionDiagnosticsPatchApplied = false
	installCollisionDiagnosticsPatch()

	const instance: Record<string, unknown> = {
		settingsManager: { getQuietStartup: () => quietStartup },
	}
	const returned = prototype[method].call(instance, [], new Map())
	return { returned, diagnostics: instance[field] }
}

describe("installCollisionDiagnosticsPatch", () => {
	beforeEach(() => {
		setVerbose(false)
		quietStartup = true
		resetPrototype()
		installCollisionDiagnosticsPatch()
	})

	afterEach(() => {
		resetPrototype()
		vi.restoreAllMocks()
	})

	it("targets existing synchronous upstream methods", () => {
		for (const [method] of DIAGNOSTIC_SINKS) {
			const original = originalMethods.get(method)
			expect(typeof original, `${method} must exist upstream`).toBe("function")
			expect(original.constructor.name, `${method} must remain synchronous`).not.toBe("AsyncFunction")
		}
	})

	it("is idempotent so repeated bootstrap does not stack wrappers", () => {
		const wrapped = prototype.updateSkillsFromPaths
		installCollisionDiagnosticsPatch()
		expect(prototype.updateSkillsFromPaths).toBe(wrapped)
	})

	it("drops only collision diagnostics on quiet startup and preserves return values", () => {
		const returnValue = { skills: [], diagnostics: [] }
		const { returned, diagnostics } = runPatchOverStub(
			"updateSkillsFromPaths",
			"skillDiagnostics",
			[warning, collision, error],
			returnValue,
		)

		expect(returned).toBe(returnValue)
		expect(diagnostics).toEqual([warning, error])
	})

	it("keeps collision diagnostics and order when startup is verbose", () => {
		setVerbose(true)
		const input = [collision, warning, error]
		const { diagnostics } = runPatchOverStub("updateSkillsFromPaths", "skillDiagnostics", input)

		expect(diagnostics).toEqual(input)
		expect(diagnostics).not.toBe(input)
	})

	it("keeps collision diagnostics when quietStartup is disabled in settings", () => {
		quietStartup = false
		const input = [collision, warning]
		const { diagnostics } = runPatchOverStub("updateSkillsFromPaths", "skillDiagnostics", input)

		expect(diagnostics).toEqual(input)
	})

	it.each(DIAGNOSTIC_SINKS)("filters %s into %s", (method, field) => {
		const { diagnostics } = runPatchOverStub(method, field, [collision, warning])
		expect(diagnostics).toEqual([warning])
	})
})
