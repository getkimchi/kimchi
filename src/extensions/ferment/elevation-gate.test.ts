import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

import { afterEach, describe, expect, it, vi } from "vitest"

import { type AllowedPermissionModes, fetchOrgPolicy } from "../../api/org-settings.js"
import { initOrgPolicy, resetOrgPolicyForTests } from "../../org-policy.js"
import { createContext } from "../__mocks__/context.js"
import type { PermissionMode } from "../permissions/types.js"
import { clearFermentGateDecision, gateFermentElevation, getFermentGateDecision } from "./elevation-gate.js"

vi.mock("../permissions/mode-controller.js", () => ({
	getPermissionMode: vi.fn(),
}))

vi.mock("../../api/org-settings.js", () => ({
	fetchOrgPolicy: vi.fn(),
}))

const { getPermissionMode } = await import("../permissions/mode-controller.js")
const mockedGetPermissionMode = vi.mocked(getPermissionMode)
const mockedFetchOrgPolicy = vi.mocked(fetchOrgPolicy)

function ctxWith(overrides: { hasUI?: boolean; select?: ReturnType<typeof vi.fn> }): ExtensionContext {
	return createContext({
		hasUI: overrides.hasUI ?? true,
		sessionManager: { getSessionId: () => "sess-gate" },
		ui: { select: overrides.select ?? vi.fn() },
	})
}

async function allowModes(modes: AllowedPermissionModes | undefined) {
	mockedFetchOrgPolicy.mockResolvedValue({ kind: "policy", orgId: "org-1", policy: { allowedPermissionModes: modes } })
	await initOrgPolicy("key", { cachePath: join(mkdtempSync(join(tmpdir(), "gate-test-")), "org-policy.json") })
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
})
