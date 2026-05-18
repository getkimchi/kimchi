import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveAgentInvocationConfig } from "./invocation-config.js"

vi.mock("../../orchestration/model-registry/recommend.js", () => ({
	recommendModel: vi.fn(),
	pickFromModelListByTier: vi.fn(),
}))

vi.mock("../../tags.js", () => ({
	getCurrentPhase: vi.fn(),
}))

import { pickFromModelListByTier, recommendModel } from "../../orchestration/model-registry/recommend.js"
import { getCurrentPhase } from "../../tags.js"

const mockRecommend = vi.mocked(recommendModel)
const mockPickFromList = vi.mocked(pickFromModelListByTier)
const mockGetPhase = vi.mocked(getCurrentPhase)

describe("resolveAgentInvocationConfig — model fallback chain", () => {
	beforeEach(() => {
		mockRecommend.mockReset()
		mockPickFromList.mockReset()
		mockGetPhase.mockReset()
		mockGetPhase.mockReturnValue(undefined)
		mockPickFromList.mockImplementation((list) => list[0])
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("step 1: params.model takes priority over everything", () => {
		const result = resolveAgentInvocationConfig(
			{
				name: "test",
				description: "t",
				extensions: true,
				skills: true,
				systemPrompt: "",
				promptMode: "replace",
				models: ["kimchi-dev/kimi-k2.6"],
				strengths: ["plan"],
			},
			{ model: "kimchi-dev/minimax-m2.7" },
		)
		expect(result.modelInput).toBe("kimchi-dev/minimax-m2.7")
		expect(result.modelFromParams).toBe(true)
		expect(mockRecommend).not.toHaveBeenCalled()
	})

	it("step 1b: locked profile model wins over params.model", () => {
		mockPickFromList.mockImplementation((list) => list[0])
		const result = resolveAgentInvocationConfig(
			{
				name: "test",
				description: "t",
				extensions: true,
				skills: true,
				systemPrompt: "",
				promptMode: "replace",
				models: ["kimchi-dev/claude-opus-4-7"],
				modelLocked: true,
			},
			{ model: "kimchi-dev/nemotron-3-super-fp4" },
		)
		expect(result.modelInput).toBe("kimchi-dev/claude-opus-4-7")
		expect(result.modelFromParams).toBe(false)
		expect(mockPickFromList).toHaveBeenCalledWith(["kimchi-dev/claude-opus-4-7"], "standard")
		expect(mockRecommend).not.toHaveBeenCalled()
	})

	it("step 2: agentConfig.models[0] used when no params.model", () => {
		const result = resolveAgentInvocationConfig(
			{
				name: "test",
				description: "t",
				extensions: true,
				skills: true,
				systemPrompt: "",
				promptMode: "replace",
				models: ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
			},
			{},
		)
		expect(result.modelInput).toBe("kimchi-dev/kimi-k2.6")
		expect(result.modelFromParams).toBe(false)
		expect(mockRecommend).not.toHaveBeenCalled()
	})

	it("step 3: recommendModel called when strengths set but no models[]", () => {
		mockRecommend.mockReturnValue({
			provider: "kimchi-dev",
			modelId: "minimax-m2.7",
			capabilities: { vision: false, strengths: ["build"], tier: "standard", description: "" },
		})
		const result = resolveAgentInvocationConfig(
			{
				name: "test",
				description: "t",
				extensions: true,
				skills: true,
				systemPrompt: "",
				promptMode: "replace",
				strengths: ["build"],
				preferTier: "standard",
			},
			{},
		)
		expect(mockRecommend).toHaveBeenCalledWith({ strengths: ["build"], preferTier: "standard" })
		expect(result.modelInput).toBe("kimchi-dev/minimax-m2.7")
		expect(result.modelFromParams).toBe(false)
	})

	it("step 3: inherits parent when recommendModel returns undefined for strengths", () => {
		mockRecommend.mockReturnValueOnce(undefined) // strengths call returns undefined
		mockGetPhase.mockReturnValue("build")

		const result = resolveAgentInvocationConfig(
			{
				name: "test",
				description: "t",
				extensions: true,
				skills: true,
				systemPrompt: "",
				promptMode: "replace",
				strengths: ["build"],
			},
			{},
		)
		// Only one call for strengths — phase is not tried when strengths are present
		expect(mockRecommend).toHaveBeenCalledTimes(1)
		expect(result.modelInput).toBeUndefined()
	})

	it("step 4 (phase fallback): uses current phase when no config model or strengths", () => {
		mockRecommend.mockReturnValue({
			provider: "kimchi-dev",
			modelId: "minimax-m2.7",
			capabilities: { vision: false, strengths: ["build"], tier: "standard", description: "" },
		})
		mockGetPhase.mockReturnValue("build")

		const result = resolveAgentInvocationConfig(
			{ name: "test", description: "t", extensions: true, skills: true, systemPrompt: "", promptMode: "replace" },
			{},
		)
		expect(mockRecommend).toHaveBeenCalledWith({ strengths: ["build"], preferTier: "standard" })
		expect(result.modelInput).toBe("kimchi-dev/minimax-m2.7")
	})

	it("inherits parent when no model, no strengths, no phase", () => {
		mockGetPhase.mockReturnValue(undefined)
		const result = resolveAgentInvocationConfig(
			{ name: "test", description: "t", extensions: true, skills: true, systemPrompt: "", promptMode: "replace" },
			{},
		)
		expect(result.modelInput).toBeUndefined()
		expect(result.modelFromParams).toBe(false)
	})

	it("ignores unknown phase values (non-strength phases)", () => {
		// Cast: testing the runtime guard against unexpected phase strings.
		mockGetPhase.mockReturnValue("unknown-phase" as never)
		const result = resolveAgentInvocationConfig(
			{ name: "test", description: "t", extensions: true, skills: true, systemPrompt: "", promptMode: "replace" },
			{},
		)
		expect(mockRecommend).not.toHaveBeenCalled()
		expect(result.modelInput).toBeUndefined()
	})
})

describe("resolveAgentInvocationConfig — tokenBudget precedence", () => {
	beforeEach(() => {
		mockRecommend.mockReset()
		mockPickFromList.mockReset()
		mockGetPhase.mockReset()
		mockGetPhase.mockReturnValue(undefined)
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("agentConfig.tokenBudget used when params has no token_budget", () => {
		const result = resolveAgentInvocationConfig(
			{
				name: "test",
				description: "t",
				extensions: true,
				skills: true,
				systemPrompt: "",
				promptMode: "replace",
				tokenBudget: 80_000,
			},
			{},
		)
		expect(result.tokenBudget).toBe(80_000)
	})

	it("params.token_budget wins over agentConfig.tokenBudget (caller takes precedence)", () => {
		const result = resolveAgentInvocationConfig(
			{
				name: "test",
				description: "t",
				extensions: true,
				skills: true,
				systemPrompt: "",
				promptMode: "replace",
				tokenBudget: 80_000,
			},
			{ token_budget: 50_000 } as Parameters<typeof resolveAgentInvocationConfig>[1] & { token_budget?: number },
		)
		expect(result.tokenBudget).toBe(50_000)
	})

	it("accepts tokenBudget as a compatibility alias", () => {
		const result = resolveAgentInvocationConfig(
			{
				name: "test",
				description: "t",
				extensions: true,
				skills: true,
				systemPrompt: "",
				promptMode: "replace",
				tokenBudget: 80_000,
			},
			{ tokenBudget: 50_000 } as Parameters<typeof resolveAgentInvocationConfig>[1] & { tokenBudget?: number },
		)
		expect(result.tokenBudget).toBe(50_000)
	})

	it("tokenBudget is undefined when neither agentConfig nor params supply a value", () => {
		const result = resolveAgentInvocationConfig(
			{
				name: "test",
				description: "t",
				extensions: true,
				skills: true,
				systemPrompt: "",
				promptMode: "replace",
			},
			{},
		)
		expect(result.tokenBudget).toBeUndefined()
	})
})

describe("resolveAgentInvocationConfig — persona policy precedence", () => {
	beforeEach(() => {
		mockRecommend.mockReset()
		mockPickFromList.mockReset()
		mockGetPhase.mockReset()
		mockGetPhase.mockReturnValue(undefined)
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("agentConfig.thinking wins over params.thinking", () => {
		const result = resolveAgentInvocationConfig(
			{
				name: "test",
				description: "t",
				extensions: true,
				skills: true,
				systemPrompt: "",
				promptMode: "replace",
				thinking: "minimal",
			},
			{ thinking: "high" },
		)
		expect(result.thinking).toBe("minimal")
	})

	it("agentConfig.maxTurns wins over params.max_turns", () => {
		const result = resolveAgentInvocationConfig(
			{
				name: "test",
				description: "t",
				extensions: true,
				skills: true,
				systemPrompt: "",
				promptMode: "replace",
				maxTurns: 3,
			},
			{ max_turns: 10 },
		)
		expect(result.maxTurns).toBe(3)
	})
})
