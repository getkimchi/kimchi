import { afterEach, describe, expect, it, vi } from "vitest"

import { type AllowedPermissionModes, fetchOrgPolicy } from "../../api/org-settings.js"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { seedOrgPolicy } from "../__mocks__/org-policy.js"
import { clampMode, getAllowedModes, highestAllowedHighMode, isFermentRunnable, isModeAllowed } from "./policy.js"

vi.mock("../../api/org-settings.js", () => ({
	fetchOrgPolicy: vi.fn(),
}))

const mockedFetchOrgPolicy = vi.mocked(fetchOrgPolicy)

function modes(enabled: Partial<AllowedPermissionModes>): AllowedPermissionModes {
	return { plan: false, default: false, auto: false, yolo: false, ...enabled }
}

/** Install a policy in the holder through the public API (mocked fetch, throwaway cache file — never the real ~/.config one). */
async function allow(modes: Parameters<typeof seedOrgPolicy>[0]) {
	await seedOrgPolicy(modes)
}

afterEach(() => {
	resetOrgPolicyForTests()
	mockedFetchOrgPolicy.mockReset()
})

describe("getAllowedModes / isModeAllowed", () => {
	it("allows everything when no policy is set (fail open)", async () => {
		await seedOrgPolicy(undefined)
		expect(getAllowedModes().size).toBe(4)
		expect(isModeAllowed("yolo")).toBe(true)
	})

	it("allows only the enabled modes", async () => {
		await allow(modes({ plan: true, default: true }))
		expect(getAllowedModes()).toEqual(new Set(["default", "plan"]))
		expect(isModeAllowed("plan")).toBe(true)
		expect(isModeAllowed("yolo")).toBe(false)
	})

	it("fails open on an all-false policy object", async () => {
		await allow(modes({}))
		expect(getAllowedModes().size).toBe(4)
	})
})

describe("highestAllowedHighMode", () => {
	it("prefers yolo over auto", async () => {
		await allow(modes({ default: true, auto: true, yolo: true }))
		expect(highestAllowedHighMode()).toBe("yolo")
	})

	it("returns auto when only auto is allowed", async () => {
		await allow(modes({ auto: true }))
		expect(highestAllowedHighMode()).toBe("auto")
	})

	it("returns undefined when no high mode is allowed", async () => {
		await allow(modes({ plan: true, default: true }))
		expect(highestAllowedHighMode()).toBeUndefined()
	})
})

describe("clampMode", () => {
	it("returns the requested mode when allowed", async () => {
		await allow(modes({ default: true, auto: true }))
		expect(clampMode("auto")).toBe("auto")
	})

	it("clamps down to the nearest allowed mode", async () => {
		await allow(modes({ default: true }))
		expect(clampMode("yolo")).toBe("default")
		expect(clampMode("auto")).toBe("default")
	})

	it("clamps plan requests to default when plan is disallowed", async () => {
		await allow(modes({ default: true }))
		expect(clampMode("plan")).toBe("default")
	})

	it("falls back to the most restrictive allowed mode for low-mode-less policies", async () => {
		await allow(modes({ auto: true }))
		expect(clampMode("default")).toBe("auto")
		expect(clampMode("plan")).toBe("auto")
	})

	it("never clamps when everything is allowed", async () => {
		await seedOrgPolicy(undefined)
		expect(clampMode("plan")).toBe("plan")
		expect(clampMode("yolo")).toBe("yolo")
	})
})

describe("isFermentRunnable", () => {
	it("is true when default is allowed even without high modes", async () => {
		await allow(modes({ plan: true, default: true }))
		expect(isFermentRunnable()).toBe(true)
	})

	it("is false for a plan-only policy", async () => {
		await allow(modes({ plan: true }))
		expect(isFermentRunnable()).toBe(false)
	})

	it("is true with any high mode allowed", async () => {
		await allow(modes({ plan: true, yolo: true }))
		expect(isFermentRunnable()).toBe(true)
	})
})
