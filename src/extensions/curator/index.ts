import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { SkillManager } from "../skills-manager/skill-manager.js"
import { runCuratorReview } from "./review.js"
import { loadState, saveState, shouldRunNow } from "./state.js"
import type { CuratorState } from "./state.js"
import { runAutoTransitions } from "./transitions.js"

export interface CuratorExtensionOptions {
	skillsDir?: string
	provider?: string
	model?: string
}

export function getStateFilePath(skillsDir: string): string {
	return join(skillsDir, ".curator_state.json")
}

export function computeIdleSeconds(state: CuratorState, now: Date): number {
	if (!state.last_session_ended_at) return Number.POSITIVE_INFINITY
	return (now.getTime() - new Date(state.last_session_ended_at).getTime()) / 1000
}

function readProviderModel(): { provider: string; model: string } | null {
	const argv = process.argv
	let provider: string | undefined
	let model: string | undefined
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--provider" && i + 1 < argv.length) provider = argv[++i]
		else if (argv[i] === "--model" && i + 1 < argv.length) model = argv[++i]
		else if (argv[i].startsWith("--provider=")) provider = argv[i].slice("--provider=".length)
		else if (argv[i].startsWith("--model=")) model = argv[i].slice("--model=".length)
	}
	return provider && model ? { provider, model } : null
}

export default function curatorExtension(pi: ExtensionAPI, options?: CuratorExtensionOptions): void {
	const skillsDir = options?.skillsDir ?? join(homedir(), ".config", "kimchi", "harness", "skills")
	const statePath = getStateFilePath(skillsDir)
	const manager = new SkillManager(skillsDir)

	const providerModel =
		options?.provider && options?.model ? { provider: options.provider, model: options.model } : readProviderModel()

	pi.on("session_start", async () => {
		const now = new Date()
		try {
			const state = await loadState(statePath)
			const idleSeconds = computeIdleSeconds(state, now)
			if (!shouldRunNow(state, idleSeconds, now)) return
			if (!providerModel) return

			void (async () => {
				try {
					await runAutoTransitions(skillsDir, now)
					await runCuratorReview({
						provider: providerModel.provider,
						model: providerModel.model,
						statePath,
						skillsDir,
						manager,
						background: true,
					})
				} catch {
					// Swallow — never block session startup
				}
			})()
		} catch {
			// Swallow — never block session startup
		}
	})

	pi.on("session_shutdown", async () => {
		try {
			const state = await loadState(statePath)
			await saveState(statePath, { ...state, last_session_ended_at: new Date().toISOString() })
		} catch {
			// Best-effort
		}
	})

	pi.registerTool({
		name: "curator",
		label: "Curator",
		description:
			"Run the skill curator. action=run: foreground consolidation pass on agent-created skills (bypasses 7-day interval). action=status: returns current curator state.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["run", "status"] },
			},
			required: ["action"],
		} as never,

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		execute: (async (_toolCallId: string, params: { action: "run" | "status" }) => {
			if (params.action === "status") {
				const state = await loadState(statePath)
				return {
					content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
					details: state,
				}
			}

			if (!providerModel) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Curator: no provider/model configured. Start kimchi with --provider and --model.",
						},
					],
					details: null,
				}
			}

			const state = await loadState(statePath)
			if (state.running && state.last_run_at) {
				const elapsedMs = Date.now() - new Date(state.last_run_at).getTime()
				if (elapsedMs < 4 * 60 * 60 * 1000) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Curator is currently running in the background. Check back later or use `curator action=status`.",
							},
						],
						details: state,
					}
				}
			}

			try {
				await runAutoTransitions(skillsDir)
				const summary = await runCuratorReview({
					provider: providerModel.provider,
					model: providerModel.model,
					statePath,
					skillsDir,
					manager,
					background: false,
				})

				const text = summary
					? [
							"Curator complete.",
							"",
							`Consolidations (${summary.consolidations.length}):`,
							...(summary.consolidations.length > 0
								? summary.consolidations.map((c) => `  - ${c.from} → ${c.into}: ${c.reason}`)
								: ["  (none)"]),
							"",
							`Archived (${summary.prunings.length}):`,
							...(summary.prunings.length > 0
								? summary.prunings.map((p) => `  - ${p.name}: ${p.reason}`)
								: ["  (none)"]),
						].join("\n")
					: "Curator complete. (no structured output received)"

				return { content: [{ type: "text" as const, text }], details: summary }
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Curator failed: ${String(err)}` }],
					details: null,
					isError: true,
				}
			}
		}) as never,
	})
}
