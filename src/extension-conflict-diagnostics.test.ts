import { DefaultResourceLoader, type Extension, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

/**
 * Drift guard for the flag-conflict diagnostics hunk in
 * patches/@earendil-works__pi-coding-agent@1.3.0.patch.
 *
 * Two behaviors pinned:
 * - entries pushed to the extension warnings channel use its declared shape
 *   (LoadExtensionsResult.warnings: { path, warning } in upstream types.d.ts).
 *   A `message` key instead of `warning` rendered as a literal "undefined" in
 *   both 1.3.0 consumers (main.js console diagnostics, interactive-mode
 *   [Extension issues] block).
 * - duplicate flag registrations with the same type and default are dropped:
 *   the parsed flag value is shared, so the winner is irrelevant and there is
 *   nothing to report.
 *
 * The hunk lives in patched dist JS outside the typecheck; a rebase that loses
 * the key rename or the suppression must fail here.
 */

type FlagDef = { description?: string; type: "boolean" | "string"; default?: boolean | string }

type ConflictDiagnostics = {
	detectExtensionConflicts: (extensions: Extension[]) => unknown
	addExtensionConflictDiagnostics: (result: LoadExtensionsResult) => void
}

const conflictDiagnostics = DefaultResourceLoader.prototype as unknown as ConflictDiagnostics

function fakeExtension(path: string, flags: Record<string, FlagDef>): Extension {
	return {
		path,
		resolvedPath: path,
		tools: new Map(),
		commands: new Map(),
		flags: new Map(Object.entries(flags)),
	} as unknown as Extension
}

function fakeToolExtension(path: string, toolName: string): Extension {
	return {
		path,
		resolvedPath: path,
		tools: new Map([[toolName, {}]]),
		commands: new Map(),
		flags: new Map(),
	} as unknown as Extension
}

function runDetection(...extensions: Extension[]): LoadExtensionsResult {
	const result = { extensions, errors: [] } as unknown as LoadExtensionsResult
	conflictDiagnostics.addExtensionConflictDiagnostics.call(
		{ detectExtensionConflicts: conflictDiagnostics.detectExtensionConflicts },
		result,
	)
	return result
}

describe("extension flag conflict diagnostics (pi patch)", () => {
	it("suppresses duplicate registrations with identical type and default", () => {
		const result = runDetection(
			fakeExtension("/ext/pkg/plannotator.js", {
				plan: { description: "plannotator plan mode", type: "boolean", default: false },
			}),
			fakeExtension("<inline:40>", { plan: { description: "start in plan mode", type: "boolean", default: false } }),
		)
		expect(result.warnings ?? []).toEqual([])
		expect(result.errors).toEqual([])
	})

	it("warns with the warnings-channel shape when definitions diverge", () => {
		const result = runDetection(
			fakeExtension("/ext/pkg/plannotator.js", { plan: { type: "boolean", default: false } }),
			fakeExtension("<inline:40>", { plan: { type: "string", default: "PLAN.md" } }),
		)
		expect(result.errors).toEqual([])
		expect(result.warnings).toHaveLength(1)
		const entry = result.warnings?.[0] as { path: string; warning: string; message?: string }
		expect(entry.path).toBe("<inline:40>")
		expect(entry.warning).toContain("--plan")
		expect(entry.warning).toContain("type/default differ")
		// Regression: a `message` key instead of `warning` rendered literal "undefined" at startup.
		expect(entry.message).toBeUndefined()
	})

	it("treats a missing default as different from an explicit default", () => {
		const result = runDetection(
			fakeExtension("/ext/pkg/a.js", { plan: { type: "boolean" } }),
			fakeExtension("<inline:40>", { plan: { type: "boolean", default: false } }),
		)
		expect(result.warnings).toHaveLength(1)
	})

	it("keeps tool conflicts as hard errors with the errors-channel shape", () => {
		const result = runDetection(
			fakeToolExtension("/ext/pkg/a.js", "submit_plan"),
			fakeToolExtension("<inline:40>", "submit_plan"),
		)
		expect(result.warnings ?? []).toEqual([])
		expect(result.errors).toHaveLength(1)
		expect(result.errors[0].path).toBe("<inline:40>")
		expect(typeof result.errors[0].error).toBe("string")
	})
})
