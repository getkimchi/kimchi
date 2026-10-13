import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { type AllowedPermissionModes, fetchOrgPolicy } from "../../api/org-settings.js"
import { initOrgPolicy, resetOrgPolicyForTests } from "../../org-policy.js"
import { clampMode, getAllowedModes, highestAllowedHighMode, isFermentRunnable, isModeAllowed } from "./policy.js"

vi.mock("../../api/org-settings.js", () => ({
	fetchOrgPolicy: vi.fn(),
}))

const mockedFetchOrgPolicy = vi.mocked(fetchOrgPolicy)

function modes(...enabled: Array<AllowedPermissionModes[keyof AllowedPermissionModes]>) {
	const [plan, defaultMode, auto, yolo] = [...enabled, false, false, false, false].slice(0, 4)
	return { plan: plan === true, default: defaultMode === true, auto: auto === true, yolo: yolo === true }
}

/** Install a policy in the holder through the public API (mocked fetch, throwaway cache file — never the real ~/.config one). */
async function allow(modes: AllowedPermissionModes | undefined) {
	mockedFetchOrgPolicy.mockResolvedValue({ kind: "policy", orgId: "org-1", policy: { allowedPermissionModes: modes } })
	await initOrgPolicy("key", { cachePath: join(mkdtempSync(join(tmpdir(), "policy-test-")), "org-policy.json") })
}

afterEach(() => {
	resetOrgPolicyForTests()
	mockedFetchOrgPolicy.mockReset()
})

describe("getAllowedModes / isModeAllowed", () => {
	it("allows everything when no policy is set (fail open)", async () => {
		mockedFetchOrgPolicy.mockResolvedValue({ kind: "policy", orgId: "org-1", policy: undefined })
		await initOrgPolicy("key", {})
		expect(getAllowedModes().size).toBe(4)
		expect(isModeAllowed("yolo")).toBe(true)
	})

	it("allows only the enabled modes", async () => {
		await allow(modes(true, true, false, false))
		expect(getAllowedModes()).toEqual(new Set(["default", "plan"]))
		expect(isModeAllowed("plan")).toBe(true)
		expect(isModeAllowed("yolo")).toBe(false)
	})

	it("fails open on an all-false policy object", async () => {
		await allow(modes(false, false, false, false))
		expect(getAllowedModes().size).toBe(4)
	})
})

describe("highestAllowedHighMode", () => {
	it("prefers yolo over auto", async () => {
		await allow(modes(false, true, true, true))
		expect(highestAllowedHighMode()).toBe("yolo")
	})

	it("returns auto when only auto is allowed", async () => {
		await allow(modes(false, false, true, false))
		expect(highestAllowedHighMode()).toBe("auto")
	})

	it("returns undefined when no high mode is allowed", async () => {
		await allow(modes(true, true, false, false))
		expect(highestAllowedHighMode()).toBeUndefined()
	})
})

describe("clampMode", () => {
	it("returns the requested mode when allowed", async () => {
		await allow(modes(false, true, true, false))
		expect(clampMode("auto")).toBe("auto")
	})

	it("clamps down to the nearest allowed mode", async () => {
		await allow(modes(false, true, false, false))
		expect(clampMode("yolo")).toBe("default")
		expect(clampMode("auto")).toBe("default")
	})

	it("clamps plan requests to default when plan is disallowed", async () => {
		await allow(modes(false, true, false, false))
		expect(clampMode("plan")).toBe("default")
	})

	it("falls back to the most restrictive allowed mode for low-mode-less policies", async () => {
		await allow(modes(false, false, true, false))
		expect(clampMode("default")).toBe("auto")
		expect(clampMode("plan")).toBe("auto")
	})

	it("never clamps when everything is allowed", async () => {
		mockedFetchOrgPolicy.mockResolvedValue({ kind: "policy", orgId: "org-1", policy: undefined })
		await initOrgPolicy("key", {})
		expect(clampMode("plan")).toBe("plan")
		expect(clampMode("yolo")).toBe("yolo")
	})
})

describe("isFermentRunnable", () => {
	it("is true when default is allowed even without high modes", async () => {
		await allow(modes(true, true, false, false))
		expect(isFermentRunnable()).toBe(true)
	})

	it("is false for a plan-only policy", async () => {
		await allow(modes(true, false, false, false))
		expect(isFermentRunnable()).toBe(false)
	})

	it("is true with any high mode allowed", async () => {
		await allow(modes(true, false, false, true))
		expect(isFermentRunnable()).toBe(true)
	})
})
