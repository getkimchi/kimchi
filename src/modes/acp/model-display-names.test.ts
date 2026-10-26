import { describe, expect, it } from "vitest"
import { prettifyModelId, resolveAcpModelDisplayName } from "./model-display-names.js"

describe("prettifyModelId", () => {
	it.each([
		["kimi-k3", "Kimi K3"],
		["auto", "Auto"],
		["auto-beta", "Auto Beta"],
		["claude-opus-4-6", "Claude Opus 4.6"],
		["claude-sonnet-4-5", "Claude Sonnet 4.5"],
		["claude-haiku-4-5", "Claude Haiku 4.5"],
		["claude-fable-5-1", "Claude Fable 5.1"],
		["glm-5.3", "GLM 5.3"],
		["glm-5.3-flash", "GLM 5.3 Flash"],
		["deepseek-v4-flash-0731", "DeepSeek v4 Flash 0731"],
		["deepseek-v4.1-flash", "DeepSeek v4.1 Flash"],
		["gemma-4-31b", "Gemma 4 31B"],
		["minimax-m3", "MiniMax M3"],
		["nemotron-3-ultra-fp4", "Nemotron 3 Ultra FP4"],
	])("prettifies %s as %s", (id, expected) => {
		expect(prettifyModelId(id)).toBe(expected)
	})
})

describe("resolveAcpModelDisplayName", () => {
	it("prettifies when the registered name equals the slug", () => {
		expect(resolveAcpModelDisplayName({ id: "kimi-k3", name: "kimi-k3" })).toBe("Kimi K3")
	})

	it("prettifies when the registered name is missing or blank", () => {
		expect(resolveAcpModelDisplayName({ id: "claude-opus-4-6" })).toBe("Claude Opus 4.6")
		expect(resolveAcpModelDisplayName({ id: "claude-opus-4-6", name: "  " })).toBe("Claude Opus 4.6")
	})

	it("keeps a real catalog display name", () => {
		expect(resolveAcpModelDisplayName({ id: "kimi-k2.5", name: "Kimi K2.5" })).toBe("Kimi K2.5")
	})

	it("keeps composite routed names intact for later splitting", () => {
		expect(resolveAcpModelDisplayName({ id: "auto", name: "Auto — Picks the best model…" })).toBe(
			"Auto — Picks the best model…",
		)
	})
})
