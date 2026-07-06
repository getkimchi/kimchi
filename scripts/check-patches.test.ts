import { describe, expect, it } from "vitest"
import { findPatchHealthcheckErrors } from "./check-patches.js"

// Mirrors the real repo: three pi-mono packages pinned to an exact version
// with a matching patch file.
type Pkg = {
	dependencies: Record<string, string>
	devDependencies: Record<string, string>
	pnpm: { patchedDependencies: Record<string, string> }
}

const IN_SYNC_PKG: Pkg = {
	dependencies: {
		"@earendil-works/pi-coding-agent": "0.79.10",
		"@earendil-works/pi-tui": "0.79.10",
		undici: "8.2.0", // non-pi-mono dep — must be ignored
	},
	devDependencies: {
		"@earendil-works/pi-ai": "0.79.10",
		vitest: "3.2.4",
	},
	pnpm: {
		patchedDependencies: {
			"@earendil-works/pi-coding-agent@0.79.10": "patches/@earendil-works__pi-coding-agent@0.79.10.patch",
			"@earendil-works/pi-tui@0.79.10": "patches/@earendil-works__pi-tui@0.79.10.patch",
			"@earendil-works/pi-ai@0.79.10": "patches/@earendil-works__pi-ai@0.79.10.patch",
			// Non-pi-mono patches (e.g. playwright-core) must be ignored.
			"playwright-core@1.59.1": "patches/playwright-core@1.59.1.patch",
		},
	},
}

const patchExists = (_patchPath: string) => true

describe("findPatchHealthcheckErrors", () => {
	it("returns no errors when versions, patchedDependencies, and patch files all align", () => {
		expect(findPatchHealthcheckErrors(IN_SYNC_PKG, patchExists)).toEqual([])
	})

	it("flags a dependabot bump that left the patchedDependencies key at the old version", () => {
		// Dependabot bumped pi-coding-agent to 0.79.11 in dependencies, but
		// pnpm.patchedDependencies still points at @0.79.10 — the exact
		// failure mode this check exists to catch.
		const bumped = structuredClone(IN_SYNC_PKG)
		bumped.dependencies["@earendil-works/pi-coding-agent"] = "0.79.11"

		const errors = findPatchHealthcheckErrors(bumped, patchExists)
		expect(errors.length).toBeGreaterThan(0)
		expect(errors.join("\n")).toContain("Version mismatch")
		expect(errors.join("\n")).toContain("0.79.11")
		expect(errors.join("\n")).toContain("@earendil-works/pi-coding-agent@0.79.10")
	})

	it("flags a patchedDependencies entry whose patch file does not exist on disk", () => {
		const missingFile = (patchPath: string) => !patchPath.includes("pi-tui")

		const errors = findPatchHealthcheckErrors(IN_SYNC_PKG, missingFile)
		expect(errors).toHaveLength(1)
		expect(errors[0]).toContain("Patch file not found")
		expect(errors[0]).toContain("@earendil-works__pi-tui@0.79.10.patch")
	})

	it("ignores non-@earendil-works dependencies and patch entries", () => {
		const pkg = {
			dependencies: { undici: "8.2.0" },
			pnpm: {
				patchedDependencies: {
					"playwright-core@1.59.1": "patches/playwright-core@1.59.1.patch",
				},
			},
		}
		// Should not error even though playwright-core has no corresponding
		// top-level dep entry — non-pi-mono patches are out of scope.
		expect(findPatchHealthcheckErrors(pkg, patchExists)).toEqual([])
	})
})
