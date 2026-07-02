import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock dependencies before importing the module under test.
vi.mock("../agent-worker-context.js", () => ({
	isAgentWorker: vi.fn(() => false),
}))

const planModeMock = vi.fn<(sessionId: string) => { mode: string } | undefined>(() => undefined)
vi.mock("../permissions/mode-controller.js", () => ({
	getPermissionMode: (sessionId: string) => planModeMock(sessionId),
}))

vi.mock("./offer-decline-store.js", () => ({
	isDeclined: vi.fn(() => false),
}))

vi.mock("../prompt-construction/index.js", () => ({
	createSystemPromptBlocks: vi.fn(() => ({ register: vi.fn() })),
}))

import { isAgentWorker } from "../agent-worker-context.js"
import { isDeclined } from "./offer-decline-store.js"
import { buildOfferPolicyBlock } from "./offer-policy-block.js"

function makeCtx(sessionId = "test-session"): unknown {
	return { sessionManager: { getSessionId: () => sessionId } }
}

function makeRuntime(active: unknown): unknown {
	return { getActive: () => active }
}

const pi = {} as never

describe("buildOfferPolicyBlock", () => {
	beforeEach(() => {
		vi.mocked(isAgentWorker).mockReturnValue(false)
		vi.mocked(isDeclined).mockReturnValue(false)
		planModeMock.mockReturnValue(undefined)
	})

	it("returns the policy text when idle (not worker, not plan, no ferment, not declined)", () => {
		const result = buildOfferPolicyBlock(makeCtx() as never, pi, makeRuntime(undefined) as never)
		expect(result).toBeTypeOf("string")
		expect(result).toBeTruthy()
		expect(result).toContain("ask_user")
		expect(result).toContain("propose_ferment_scoping")
		expect(result).toContain("force")
		expect(result).toContain("respect")
		expect(result).toContain("re-offer")
	})

	it("returns undefined when a ferment IS active", () => {
		const result = buildOfferPolicyBlock(makeCtx() as never, pi, makeRuntime({ id: "f1", status: "running" }) as never)
		expect(result).toBeUndefined()
	})

	it("returns undefined when isAgentWorker() is true", () => {
		vi.mocked(isAgentWorker).mockReturnValue(true)
		const result = buildOfferPolicyBlock(makeCtx() as never, pi, makeRuntime(undefined) as never)
		expect(result).toBeUndefined()
	})

	it("returns undefined when in plan mode", () => {
		planModeMock.mockReturnValue({ mode: "plan" })
		const result = buildOfferPolicyBlock(makeCtx() as never, pi, makeRuntime(undefined) as never)
		expect(result).toBeUndefined()
	})

	it("returns undefined when the user has declined a ferment offer this session", () => {
		vi.mocked(isDeclined).mockReturnValue(true)
		const result = buildOfferPolicyBlock(makeCtx() as never, pi, makeRuntime(undefined) as never)
		expect(result).toBeUndefined()
	})
})
