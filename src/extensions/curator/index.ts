import { watch } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent"
import { Container, Text } from "@earendil-works/pi-tui"
import { isSubagent } from "../prompt-construction/prompt-enrichment.js"
import { SkillManager } from "../skills-manager/skill-manager.js"
import { UsageTracker } from "../skills-manager/usage.js"
import { debugLog, runCuratorReview, spawnSessionReview } from "./review.js"
import { loadState, saveState, shouldRunNow } from "./state.js"
import type { CuratorState } from "./state.js"
import { runAutoTransitions } from "./transitions.js"

const CURATOR_NOTIFICATION_TYPE = "curator-notification"

interface CuratorNotificationData {
	names: string[]
}

const curatorNotificationRenderer: MessageRenderer<CuratorNotificationData> = (message, _options, theme) => {
	const data = message.details as CuratorNotificationData
	if (!data?.names?.length) return undefined
	const container = new Container()
	const symbol = theme.fg("dim", "✦ ")
	const label = theme.bold(theme.fg("toolTitle", "Skill review"))
	const names = theme.fg("dim", `  created: ${data.names.join(", ")}`)
	container.addChild(new Text(`${symbol}${label}${names}`, 0, 0))
	return container
}

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

export default function curatorExtension(pi: ExtensionAPI, options?: CuratorExtensionOptions): void {
	if (isSubagent()) return
	pi.registerMessageRenderer(CURATOR_NOTIFICATION_TYPE, curatorNotificationRenderer)
	const skillsDir = options?.skillsDir ?? join(homedir(), ".config", "kimchi", "harness", "skills")
	const statePath = getStateFilePath(skillsDir)
	const manager = new SkillManager(skillsDir)
	const tracker = new UsageTracker(skillsDir)

	let providerModel: { provider: string; model: string } | null =
		options?.provider && options?.model ? { provider: options.provider, model: options.model } : null

	// Tracks agent_created skill names known at session start — used as baseline for review notifications.
	let knownAgentSkills = new Set<string>()

	// Capture provider/model from the first real LLM request — works regardless of how kimchi is invoked.
	pi.on("before_provider_request", (_event, ctx) => {
		if (!providerModel && ctx.model?.provider && ctx.model?.id) {
			providerModel = { provider: ctx.model.provider, model: ctx.model.id }
		}
	})

	const SESSION_REVIEW_THRESHOLD = Number(process.env.KIMCHI_REVIEW_THRESHOLD ?? 5)

	debugLog(`curator registered: threshold=${SESSION_REVIEW_THRESHOLD} skillsDir=${skillsDir}`)

	pi.on("agent_end", (event) => {
		const turnCount = event.messages.filter((m) => (m as { role: string }).role === "assistant").length
		debugLog(
			`agent_end fired: turnCount=${turnCount} threshold=${SESSION_REVIEW_THRESHOLD} providerModel=${JSON.stringify(providerModel)}`,
		)
		if (turnCount < SESSION_REVIEW_THRESHOLD) {
			debugLog("agent_end: below threshold, skipping review")
			return
		}
		if (!providerModel) {
			debugLog("agent_end: no providerModel, skipping review")
			return
		}
		debugLog("agent_end: dispatching spawnSessionReview")
		spawnSessionReview({
			provider: providerModel.provider,
			model: providerModel.model,
			skillsDir,
			messages: event.messages,
		})

		// Watch skillsDir for .usage.json changes and notify when new agent_created skills appear.
		const baseline = new Set(knownAgentSkills)
		let debounce: ReturnType<typeof setTimeout> | undefined

		let watcher: ReturnType<typeof watch> | undefined
		try {
			watcher = watch(skillsDir, { persistent: false }, (_eventType, filename) => {
				if (filename !== ".usage.json") return
				clearTimeout(debounce)
				debounce = setTimeout(async () => {
					try {
						const entries = await tracker.list()
						const newSkills = entries.filter((e) => e.agent_created && !baseline.has(e.name)).map((e) => e.name)
						if (newSkills.length === 0) return
						for (const s of newSkills) {
							baseline.add(s)
							knownAgentSkills.add(s)
						}
						pi.sendMessage({
							customType: CURATOR_NOTIFICATION_TYPE,
							content: [
								{ type: "text", text: "<system-annotation>Skill review created new skills</system-annotation>" },
							],
							display: true,
							details: { names: newSkills } satisfies CuratorNotificationData,
						})
					} catch {
						// best-effort
					}
				}, 500)
			})
		} catch {
			// skillsDir may not exist yet — watcher is best-effort
		}

		// Clean up after 10 minutes regardless of outcome.
		const cleanup = setTimeout(
			() => {
				clearTimeout(debounce)
				watcher?.close()
			},
			10 * 60 * 1000,
		)
		cleanup.unref()
	})

	pi.on("session_start", async () => {
		const now = new Date()

		try {
			const state = await loadState(statePath)

			// Detect skills created by a previous session's background review and notify.
			const currentAgentSkills = (await manager.listInventory()).filter((s) => s.agent_created).map((s) => s.name)
			knownAgentSkills = new Set(currentAgentSkills)
			const known = new Set(state.known_agent_skills ?? [])
			const newSkills = currentAgentSkills.filter((n) => !known.has(n))
			if (newSkills.length > 0) {
				pi.sendMessage({
					customType: CURATOR_NOTIFICATION_TYPE,
					content: [{ type: "text", text: `skill review created: ${newSkills.join(", ")}` }],
					display: true,
				})
				await saveState(statePath, { ...state, known_agent_skills: currentAgentSkills })
			} else if (state.known_agent_skills === undefined) {
				// First run — seed without notifying
				await saveState(statePath, { ...state, known_agent_skills: currentAgentSkills })
			}

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
