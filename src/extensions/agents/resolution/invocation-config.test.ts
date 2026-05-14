import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveAgentInvocationConfig } from "./invocation-config.js"

// Mock recommendModel + pickFromModelListByTier to control output in tests
vi.mock("../../orchestration/model-registry/recommend.js", () => ({
	recommendModel: vi.fn(),
	pickFromModelListByTier: vi.fn(),
}))

// Mock getCurrentPhase so tests are deterministic
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
		// Default behavior: return first entry (matches caller's earlier expectation).
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
