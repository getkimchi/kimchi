import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

import { afterEach, describe, expect, it, vi } from "vitest"

import { fetchOrgPolicy } from "../../api/org-settings.js"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { createContext } from "../__mocks__/context.js"
import { seedOrgPolicy } from "../__mocks__/org-policy.js"
import type { PermissionMode } from "../permissions/types.js"
import { effectiveContinuationPolicy } from "./continuation.js"
import {
	applyDegradedFermentStart,
	clearFermentGateDecision,
	deactivateIfStillActive,
	FERMENT_PLAN_ONLY_MESSAGE,
	gateFermentElevation,
	getFermentGateDecision,
} from "./elevation-gate.js"
import type { FermentRuntime } from "./runtime.js"

vi.mock("../permissions/mode-controller.js", () => ({
	getPermissionMode: vi.fn(),
}))

vi.mock("../../api/org-settings.js", () => ({
	fetchOrgPolicy: vi.fn(),
}))

const { getPermissionMode } = await import("../permissions/mode-controller.js")
const mockedGetPermissionMode = vi.mocked(getPermissionMode)
const mockedFetchOrgPolicy = vi.mocked(fetchOrgPolicy)

function ctxWith(overrides: {
	hasUI?: boolean
	select?: ReturnType<typeof vi.fn>
	notify?: ReturnType<typeof vi.fn>
	setStatus?: ReturnType<typeof vi.fn>
}): ExtensionContext {
	return createContext({
		hasUI: overrides.hasUI ?? true,
		sessionManager: { getSessionId: () => "sess-gate" },
		ui: {
			select: overrides.select ?? vi.fn(),
			notify: overrides.notify ?? vi.fn(),
			setStatus: overrides.setStatus ?? vi.fn(),
		},
	})
}

async function allowModes(modes: Parameters<typeof seedOrgPolicy>[0]) {
	await seedOrgPolicy(modes)
}

function runningIn(mode: PermissionMode) {
	mockedGetPermissionMode.mockReturnValue({ mode, source: "runtime", initiatedBy: "user" })
}

afterEach(() => {
	resetOrgPolicyForTests()
	mockedFetchOrgPolicy.mockReset()
	mockedGetPermissionMode.mockReset()
	clearFermentGateDecision("f1")
})

describe("gateFermentElevation", () => {
	it("stays without asking when no policy restricts modes (fail open)", async () => {
		await allowModes(undefined)
		runningIn("default")
		const select = vi.fn()
		const outcome = await gateFermentElevation(ctxWith({ select }), "f1")
		expect(select).not.toHaveBeenCalled()
		expect(outcome).toEqual({ kind: "stayed" })
	})

	it("does not gate when already in yolo", async () => {
		await allowModes(undefined)
		runningIn("yolo")
		const outcome = await gateFermentElevation(ctxWith({}), "f1")
		expect(outcome).toEqual({ kind: "stayed" })
		expect(getFermentGateDecision("f1")).toEqual({ kind: "stayed" })
	})

	it("does not gate auto when yolo is disallowed", async () => {
		await allowModes({ plan: false, default: true, auto: true, yolo: false })
		runningIn("auto")
		const outcome = await gateFermentElevation(ctxWith({}), "f1")
		expect(outcome).toEqual({ kind: "stayed" })
	})

	it("asks auto users to elevate to yolo; declining stays with no penalty", async () => {
		await allowModes({ plan: true, default: true, auto: true, yolo: true })
		runningIn("auto")
		const select = vi.fn().mockResolvedValue("Continue in auto")
		const outcome = await gateFermentElevation(ctxWith({ select }), "f1")
		expect(select).toHaveBeenCalledTimes(1)
		expect(outcome).toEqual({ kind: "stayed" })
	})

	it("elevates auto → yolo on accept", async () => {
		await allowModes({ plan: true, default: true, auto: true, yolo: true })
		runningIn("auto")
		const select = vi.fn().mockResolvedValue("Elevate to yolo & run")
		const outcome = await gateFermentElevation(ctxWith({ select }), "f1")
		expect(outcome).toEqual({ kind: "elevated", mode: "yolo" })
		expect(getFermentGateDecision("f1")).toEqual({ kind: "elevated", mode: "yolo" })
	})

	it("asks default users to elevate to the highest allowed high mode", async () => {
		await allowModes({ plan: false, default: true, auto: true, yolo: false })
		runningIn("default")
		const select = vi.fn().mockResolvedValue("Elevate to auto & run")
		const outcome = await gateFermentElevation(ctxWith({ select }), "f1")
		expect(select.mock.calls[0]?.[1]?.[0]).toBe("Elevate to auto & run")
		expect(outcome).toEqual({ kind: "elevated", mode: "auto" })
	})

	it("degrades when a default-mode user declines", async () => {
		await allowModes({ plan: true, default: true, auto: true, yolo: true })
		runningIn("default")
		const select = vi.fn().mockResolvedValue("Run in default (degraded)")
		const outcome = await gateFermentElevation(ctxWith({ select }), "f1")
		expect(outcome).toEqual({ kind: "degraded" })
		expect(getFermentGateDecision("f1")).toEqual({ kind: "degraded" })
	})

	it("degrades without asking when no high mode is allowed", async () => {
		await allowModes({ plan: true, default: true, auto: false, yolo: false })
		runningIn("default")
		const select = vi.fn()
		const outcome = await gateFermentElevation(ctxWith({ select }), "f1")
		expect(select).not.toHaveBeenCalled()
		expect(outcome).toEqual({ kind: "degraded" })
	})

	it("blocks a plan-only policy", async () => {
		await allowModes({ plan: true, default: false, auto: false, yolo: false })
		runningIn("plan")
		const outcome = await gateFermentElevation(ctxWith({}), "f1")
		expect(outcome).toEqual({ kind: "blocked" })
		expect(getFermentGateDecision("f1")).toBeUndefined()
	})

	it("treats a dismissed dialog as cancelled and records nothing", async () => {
		await allowModes({ plan: true, default: true, auto: true, yolo: true })
		runningIn("default")
		const select = vi.fn().mockResolvedValue(undefined)
		const outcome = await gateFermentElevation(ctxWith({ select }), "f1")
		expect(outcome).toEqual({ kind: "cancelled" })
		expect(getFermentGateDecision("f1")).toBeUndefined()
	})

	it("stays without asking when there is no UI (headless resume)", async () => {
		await allowModes(undefined)
		runningIn("default")
		const outcome = await gateFermentElevation(ctxWith({ hasUI: false }), "f1")
		expect(outcome).toEqual({ kind: "stayed" })
	})

	it("blocks a plan-only policy before reaching the no-UI short-circuit", async () => {
		await allowModes({ plan: true, default: false, auto: false, yolo: false })
		runningIn("plan")
		const outcome = await gateFermentElevation(ctxWith({ hasUI: false }), "f1")
		expect(outcome).toEqual({ kind: "blocked" })
	})
})

describe("concurrent gates", () => {
	afterEach(() => {
		clearFermentGateDecision("fA")
		clearFermentGateDecision("fB")
	})

	function deferred() {
		let resolve!: (value: string | undefined) => void
		const promise = new Promise<string | undefined>((r) => (resolve = r))
		return { promise, resolve }
	}

	it("a second gate for the same ferment joins the in-flight one instead of opening a competing dialog", async () => {
		await allowModes({ plan: true, default: true, auto: true, yolo: true })
		runningIn("default")
		const d = deferred()
		const select = vi.fn().mockReturnValue(d.promise)

		const first = gateFermentElevation(ctxWith({ select }), "f1")
		const second = gateFermentElevation(ctxWith({ select }), "f1")
		expect(second).toBe(first)
		expect(select).toHaveBeenCalledTimes(1)

		d.resolve("Elevate to yolo & run")
		const [a, b] = await Promise.all([first, second])
		expect(a).toEqual({ kind: "elevated", mode: "yolo" })
		expect(b).toEqual(a)
		expect(getFermentGateDecision("f1")).toEqual({ kind: "elevated", mode: "yolo" })
	})

	it("two ferments gated concurrently keep their decisions separate across the await point", async () => {
		await allowModes({ plan: true, default: true, auto: true, yolo: true })
		runningIn("default")
		const dA = deferred()
		const dB = deferred()
		const selectA = vi.fn().mockReturnValue(dA.promise)
		const selectB = vi.fn().mockReturnValue(dB.promise)

		const gateA = gateFermentElevation(ctxWith({ select: selectA }), "fA")
		const gateB = gateFermentElevation(ctxWith({ select: selectB }), "fB")
		expect(selectA).toHaveBeenCalledTimes(1)
		expect(selectB).toHaveBeenCalledTimes(1)

		// B's dialog settles first (cancel records nothing), then A elevates.
		dB.resolve("Cancel")
		dA.resolve("Elevate to yolo & run")
		const [a, b] = await Promise.all([gateA, gateB])
		expect(a).toEqual({ kind: "elevated", mode: "yolo" })
		expect(b).toEqual({ kind: "cancelled" })
		expect(getFermentGateDecision("fA")).toEqual({ kind: "elevated", mode: "yolo" })
		expect(getFermentGateDecision("fB")).toBeUndefined()
	})
})

describe("applyDegradedFermentStart", () => {
	it("marks only the declined ferment for manual continuation — never the global policy", () => {
		const notify = vi.fn()
		const setStatus = vi.fn()
		applyDegradedFermentStart(ctxWith({ notify, setStatus }), "f1")

		expect(effectiveContinuationPolicy("f1", "automated")).toBe("manual")
		expect(effectiveContinuationPolicy("ferment-other", "automated")).toBe("automated")
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("degraded"), "warning")
		expect(setStatus).toHaveBeenCalledWith("ferment-degraded", expect.any(String))
	})

	it("a later elevated gate decision clears the stale degraded marker", async () => {
		applyDegradedFermentStart(ctxWith({}), "f1")
		expect(effectiveContinuationPolicy("f1", "automated")).toBe("manual")

		await allowModes({ plan: true, default: true, auto: true, yolo: true })
		runningIn("default")
		const select = vi.fn().mockResolvedValue("Elevate to yolo & run")
		await gateFermentElevation(ctxWith({ select }), "f1")

		expect(effectiveContinuationPolicy("f1", "automated")).toBe("automated")
	})

	it("clearFermentGateDecision drops the degraded marker too", () => {
		applyDegradedFermentStart(ctxWith({}), "f1")
		expect(effectiveContinuationPolicy("f1", "automated")).toBe("manual")

		clearFermentGateDecision("f1")
		expect(effectiveContinuationPolicy("f1", "automated")).toBe("automated")
	})
})

describe("deactivateIfStillActive", () => {
	function runtimeWithActive(activeId: string | undefined) {
		return {
			getActive: () => (activeId ? { id: activeId } : undefined),
			setActive: vi.fn(),
		}
	}

	it("deactivates when the gated ferment still owns the global active slot", () => {
		const runtime = runtimeWithActive("f1")
		deactivateIfStillActive(runtime as unknown as FermentRuntime, "f1")
		expect(runtime.setActive).toHaveBeenCalledWith(undefined)
	})

	it("leaves another ferment alone when it claimed the slot while the gate was open", () => {
		const runtime = runtimeWithActive("ferment-b")
		deactivateIfStillActive(runtime as unknown as FermentRuntime, "f1")
		expect(runtime.setActive).not.toHaveBeenCalled()
	})

	it("is a no-op when nothing is active", () => {
		const runtime = runtimeWithActive(undefined)
		deactivateIfStillActive(runtime as unknown as FermentRuntime, "f1")
		expect(runtime.setActive).not.toHaveBeenCalled()
	})
})

describe("FERMENT_PLAN_ONLY_MESSAGE", () => {
	it("is the shared plan-only rejection text", () => {
		expect(FERMENT_PLAN_ONLY_MESSAGE).toContain("plan mode")
	})
})
