/**
 * /models slash command — interactive model role configuration.
 *
 * Shows the current role assignments and lets the user change them
 * by selecting from available models. Changes are persisted to
 * ~/.config/kimchi/harness/settings.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getAvailableModels } from "../../startup-context.js"
import {
	DEFAULT_MODEL_ROLES,
	type ModelRoles,
	getModelRoles,
	modelIdFromRef,
	saveModelRoles,
	splitModelRef,
} from "./model-roles.js"

const ROLE_LABELS: Record<keyof ModelRoles, { label: string; description: string }> = {
	orchestrator: { label: "Orchestrator", description: "main model, delegates work" },
	planner: { label: "Planner", description: "designs the approach, writes specs" },
	builder: { label: "Builder", description: "code implementation" },
	reviewer: { label: "Reviewer", description: "code review" },
	explorer: { label: "Explorer", description: "codebase exploration, research" },
}

const ROLE_KEYS: (keyof ModelRoles)[] = ["orchestrator", "planner", "builder", "reviewer", "explorer"]

function formatRoleDisplay(role: keyof ModelRoles, modelRef: string): string {
	const info = ROLE_LABELS[role]
	const isDefault = modelRef === DEFAULT_MODEL_ROLES[role]
	const suffix = isDefault ? " (default)" : ""
	return `${info.label}: ${modelRef}${suffix}`
}

export function registerModelRolesCommand(pi: ExtensionAPI): void {
	pi.registerCommand("multi-model", {
		description: "Configure model roles (orchestrator, planner, builder, reviewer, explorer)",
		async handler(_args, ctx) {
			if (!ctx.hasUI) {
				ctx.ui.notify("Model roles configuration requires an interactive session.", "warning")
				return
			}

			const roles = { ...getModelRoles() }

			// Build the available models list from the API
			const apiModels = getAvailableModels()
			const availableModelRefs = apiModels.map((m) => `kimchi-dev/${m.slug}`)

			// Also allow any currently-configured model (it might be from a different provider)
			for (const key of ROLE_KEYS) {
				const ref = roles[key]
				if (!availableModelRefs.includes(ref)) {
					availableModelRefs.push(ref)
				}
			}

			const showMainMenu = async (): Promise<void> => {
				const options = [...ROLE_KEYS.map((key) => formatRoleDisplay(key, roles[key])), "Reset all to defaults"]

				const choice = await ctx.ui.select("Model Roles", options)
				if (!choice) return

				if (choice === "Reset all to defaults") {
					const prevOrchestrator = roles.orchestrator
					Object.assign(roles, DEFAULT_MODEL_ROLES)
					try {
						saveModelRoles(roles)
					} catch (err) {
						ctx.ui.notify(`Failed to save model roles: ${err instanceof Error ? err.message : err}`, "error")
						return
					}
					ctx.ui.notify("Model roles reset to defaults.", "info")

					// Switch the active model if the orchestrator changed
					if (prevOrchestrator !== DEFAULT_MODEL_ROLES.orchestrator) {
						const parsed = splitModelRef(DEFAULT_MODEL_ROLES.orchestrator)
						if (parsed) {
							const target = ctx.modelRegistry?.find(parsed.provider, parsed.modelId)
							if (target) {
								try {
									await pi.setModel(target)
								} catch {
									// best-effort
								}
							}
						}
					}
					return
				}

				// Find which role was selected
				const roleIndex = ROLE_KEYS.findIndex((key) => choice === formatRoleDisplay(key, roles[key]))
				if (roleIndex === -1) return

				const roleKey = ROLE_KEYS[roleIndex]
				await showRoleEditor(roleKey)
				await showMainMenu()
			}

			const showRoleEditor = async (roleKey: keyof ModelRoles): Promise<void> => {
				const info = ROLE_LABELS[roleKey]
				const current = roles[roleKey]

				// Build options: available models + custom input
				const modelOptions = availableModelRefs.map((ref) => {
					const isCurrent = ref === current
					const isDefault = ref === DEFAULT_MODEL_ROLES[roleKey]
					const tags: string[] = []
					if (isCurrent) tags.push("current")
					if (isDefault) tags.push("default")
					const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : ""
					return `${ref}${suffix}`
				})
				modelOptions.push("Enter custom model...")

				const choice = await ctx.ui.select(`${info.label} — ${info.description}`, modelOptions)
				if (!choice) return

				let newRef: string

				if (choice === "Enter custom model...") {
					const input = await ctx.ui.input("Model (provider/model-id):", current)
					if (!input?.trim()) return
					newRef = input.trim()

					// Validate format
					if (!splitModelRef(newRef)) {
						ctx.ui.notify(
							`Invalid format: "${newRef}". Expected "provider/model-id" (e.g. "anthropic/claude-sonnet-4-5").`,
							"error",
						)
						return
					}

					// Warn if model is not available
					const modelId = modelIdFromRef(newRef)
					const availableIds = new Set(apiModels.map((m) => m.slug))
					if (!availableIds.has(modelId)) {
						ctx.ui.notify(
							`Note: "${newRef}" is not in the available models list. It will be used if the provider is configured.`,
							"warning",
						)
					}
				} else {
					// Strip the (current), (default) suffixes
					newRef = choice.replace(/\s*\(.*\)$/, "")
				}

				roles[roleKey] = newRef
				try {
					saveModelRoles(roles)
				} catch (err) {
					ctx.ui.notify(`Failed to save model roles: ${err instanceof Error ? err.message : err}`, "error")
					return
				}
				ctx.ui.notify(`${info.label} set to ${newRef}`, "info")

				// When the orchestrator role changes, switch the active model to match
				if (roleKey === "orchestrator") {
					const parsed = splitModelRef(newRef)
					if (parsed) {
						const target = ctx.modelRegistry?.find(parsed.provider, parsed.modelId)
						if (target) {
							try {
								await pi.setModel(target)
							} catch {
								ctx.ui.notify(`Could not switch to ${newRef}. The model will be used next session.`, "warning")
							}
						}
					}
				}
			}

			await showMainMenu()
		},
	})
}
