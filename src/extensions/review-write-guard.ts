import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getCurrentPhase } from "./tags.js"

const IMPLEMENTATION_TOOLS = new Set(["edit", "write"])
const DELEGATION_TOOLS = new Set(["Agent"])

export interface OrchestratorWriteGuardOptions {
	/** Tools that count as implementation work. Default: edit, write. */
	implementationTools?: Set<string>
	/** Number of implementation tool calls after a subagent return in build phase before a steer fires. Default: 2 */
	buildPhaseThreshold?: number
	/** Number of implementation tool calls after a subagent return in build phase before a hard block fires. Default: 5 */
	buildPhaseBlockThreshold?: number
}

export const STEER_MESSAGE_TYPE = "review-write-guard-steer"

const REVIEW_BLOCK_REASON =
	"BLOCKED: You are in the review phase. The orchestrator must not edit implementation files during review. " +
	"Delegate fixes to a build agent instead — spawn an Agent with the fix task and the list of issues."

const BUILD_STEER_MESSAGE =
	"Delegation guard: you are editing files that a subagent produced. " +
	"The orchestrator should not fix subagent output directly — it wastes orchestrator tokens. " +
	"Spawn a fix Agent with the test failures and let it handle the corrections."

const BUILD_BLOCK_REASON =
	"BLOCKED: You have continued editing subagent output after being warned. " +
	"The orchestrator must not do a subagent's job. Spawn a fix Agent with the remaining work."

export class OrchestratorWriteGuard {
	private readonly implementationTools: Set<string>
	private readonly delegationTools: Set<string>
	private readonly buildPhaseThreshold: number
	private readonly buildPhaseBlockThreshold: number

	private subagentReturnedInBuild = false
	private buildWriteCount = 0
	private buildSteered = false

	constructor(options: OrchestratorWriteGuardOptions = {}) {
		this.implementationTools = options.implementationTools ?? new Set(IMPLEMENTATION_TOOLS)
		this.delegationTools = new Set(DELEGATION_TOOLS)
		this.buildPhaseThreshold = options.buildPhaseThreshold ?? 2
		this.buildPhaseBlockThreshold = options.buildPhaseBlockThreshold ?? 5
	}

	reset(): void {
		this.subagentReturnedInBuild = false
		this.buildWriteCount = 0
		this.buildSteered = false
	}

	checkToolCall(toolName: string): { block: true; reason: string } | { steer: string } | undefined {
		const phase = getCurrentPhase()

		if (this.delegationTools.has(toolName)) {
			this.subagentReturnedInBuild = false
			this.buildWriteCount = 0
			this.buildSteered = false
			return undefined
		}

		if (phase === "review" && this.implementationTools.has(toolName)) {
			return { block: true, reason: REVIEW_BLOCK_REASON }
		}

		if (phase === "build" && this.implementationTools.has(toolName)) {
			if (!this.subagentReturnedInBuild) return undefined

			this.buildWriteCount++
			if (this.buildWriteCount >= this.buildPhaseBlockThreshold) {
				return { block: true, reason: BUILD_BLOCK_REASON }
			}
			if (this.buildWriteCount >= this.buildPhaseThreshold && !this.buildSteered) {
				this.buildSteered = true
				return { steer: BUILD_STEER_MESSAGE }
			}
		}

		if (phase !== "review" && phase !== "build") {
			this.reset()
		}

		return undefined
	}

	recordSubagentReturn(): void {
		const phase = getCurrentPhase()
		if (phase === "build") {
			this.subagentReturnedInBuild = true
			this.buildWriteCount = 0
			this.buildSteered = false
		}
	}

	getState(): { subagentReturnedInBuild: boolean; buildWriteCount: number; buildSteered: boolean } {
		return {
			subagentReturnedInBuild: this.subagentReturnedInBuild,
			buildWriteCount: this.buildWriteCount,
			buildSteered: this.buildSteered,
		}
	}
}

export default function reviewWriteGuardExtension(pi: ExtensionAPI, options?: OrchestratorWriteGuardOptions): void {
	const guard = new OrchestratorWriteGuard(options)

	pi.on("session_start", () => {
		guard.reset()
	})

	pi.on("tool_call", (event) => {
		if (!event.toolName) return

		if (event.toolName === "Agent") {
			return { block: false }
		}

		const result = guard.checkToolCall(event.toolName)
		if (!result) return { block: false }

		if ("block" in result) {
			return { block: true, reason: result.reason }
		}

		pi.sendMessage(
			{
				customType: STEER_MESSAGE_TYPE,
				content: [{ type: "text", text: result.steer }],
				display: false,
			},
			{ deliverAs: "steer" },
		)
		return { block: false }
	})

	pi.on("tool_result", (event) => {
		if (event.toolName === "Agent") {
			guard.recordSubagentReturn()
		}
	})
}
