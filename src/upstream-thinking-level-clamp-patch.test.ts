import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { __clearModelThinkingLevelsForTest, registerModelThinkingLevels } from "./models.js"
import { __uninstallThinkingLevelAdvisorForTest, installThinkingLevelAdvisor } from "./thinking-selection.js"

/**
 * Contract for the curated thinking-level clamp hunks in
 * patches/@earendil-works__pi-coding-agent@1.3.0.patch — exercised against the
 * real (patched) AgentSession in-process, via createAgentSession.
 *
 * The clamp must run on EVERY level assignment, not only when the requested
 * level falls outside getAvailableThinkingLevels(): that method keeps pi's
 * computed set for curated-none models (a non-empty contract for clamping and
 * cycling), so its includes() check would otherwise let a pi-supported level
 * through untouched. The user-visible consequence of the gap: switching to a
 * curated-none model kept the previous level, sending an explicit effort
 * (anthropic: thinking budgets) while the UI showed "provider default".
 *
 * When the hunks are lost (e.g. after re-generating the patch), the
 * model-switch and assignment expectations below regress to the unclamped
 * levels.
 */

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

describe("upstream thinking-level clamp patch (AgentSession)", () => {
	let tempDir: string
	let agentDir: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-thinking-clamp-test-"))
		agentDir = join(tempDir, "harness")
		mkdirSync(agentDir, { recursive: true })
		// models.json mirrors metadataToModel's output for the curated pair:
		// glm-5.3 (curated low/high/max, ai-enabler map) and minimax-m3
		// (curated-none, plus the compat stamp that keeps reasoning_effort off
		// the wire). settings.json pins the initial model.
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify(
				{
					providers: {
						"kimchi-dev": {
							baseUrl: "http://127.0.0.1:9/openai/v1",
							apiKey: "fake",
							api: "openai-completions",
							authHeader: true,
							models: [
								{
									id: "glm-5.3",
									name: "GLM 5.3",
									reasoning: true,
									input: ["text"],
									contextWindow: 202_752,
									maxTokens: 8_192,
									cost: COST,
									provider: "ai-enabler",
									thinkingLevels: ["low", "high", "max"],
									thinkingLevelMap: { off: "none", max: "max" },
								},
								{
									id: "minimax-m3",
									name: "MiniMax M3",
									reasoning: true,
									input: ["text"],
									contextWindow: 202_752,
									maxTokens: 8_192,
									cost: COST,
									provider: "ai-enabler",
									thinkingLevels: [],
									thinkingLevelMap: { off: "none", max: "max" },
									compat: { supportsReasoningEffort: false },
								},
							],
						},
					},
				},
				null,
				"\t",
			),
			"utf-8",
		)
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "kimchi-dev", defaultModel: "glm-5.3" }, null, "\t"),
			"utf-8",
		)
		__clearModelThinkingLevelsForTest()
		installThinkingLevelAdvisor()
		registerModelThinkingLevels("kimchi-dev/glm-5.3", ["low", "high", "max"])
		registerModelThinkingLevels("kimchi-dev/minimax-m3", [])
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		__clearModelThinkingLevelsForTest()
		__uninstallThinkingLevelAdvisorForTest()
	})

	it("clamps every level assignment and model switch to the curated set", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			sessionManager: SessionManager.inMemory(tempDir),
		})

		// Startup: the default level (medium) rank-clamps upward into the
		// curated set via the shared createAgentSession seam.
		expect(session.model?.id).toBe("glm-5.3")
		expect(session.thinkingLevel).toBe("high")

		// A pi-supported level outside the curated set clamps on assignment.
		session.setThinkingLevel("medium")
		expect(session.thinkingLevel).toBe("high")
		session.setThinkingLevel("low")
		expect(session.thinkingLevel).toBe("low")

		// THE MODEL-SWITCH REGRESSION: switching to a curated-none model must
		// settle on "off" — pi's set would let the previous level through
		// unclamped, deriving an explicit effort while the UI shows "on".
		const minimax = session.modelRuntime.getModel("kimchi-dev", "minimax-m3")
		expect(minimax).toBeDefined()
		if (!minimax) throw new Error("minimax-m3 missing from models.json")
		await session.setModel(minimax)
		expect(session.thinkingLevel).toBe("off")

		// RPC-style assignment on the curated-none model also settles on
		// "off", even though "high" is in pi's set.
		session.setThinkingLevel("high")
		expect(session.thinkingLevel).toBe("off")

		// Switching back rank-clamps from "off" into the curated set.
		const glm = session.modelRuntime.getModel("kimchi-dev", "glm-5.3")
		expect(glm).toBeDefined()
		if (!glm) throw new Error("glm-5.3 missing from models.json")
		await session.setModel(glm)
		expect(session.thinkingLevel).toBe("low")
	})
})
