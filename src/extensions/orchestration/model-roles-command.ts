/**
 * /models slash command — interactive model role configuration.
 *
 * Shows the current role assignments and lets the user change them
 * by selecting from available models. Changes are persisted to
 * ~/.config/kimchi/harness/settings.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getAvailableModels } from "../../startup-context.js"
import { setProcessOrchestratorRef } from "../kimchi-process.js"
import { getMultiModelEnabled } from "../prompt-construction/prompt-enrichment.js"
import { MODEL_CAPABILITIES } from "./model-registry/builtin-models.js"
import {
	type CustomModelConfig,
	DEFAULT_MODEL_ROLES,
	type ModelRoles,
	type RoleModelAssignment,
	extractCustomConfigs,
	getModelRoles,
	modelIdFromRef,
	normalizeRoleModels,
	saveModelRoles,
	splitModelRef,
} from "./model-roles.js"

function syncOrchestratorRef(roles: ModelRoles): void {
	setProcessOrchestratorRef(roles.orchestrator)
}

const ROLE_LABELS: Record<keyof ModelRoles, { label: string; description: string }> = {
	orchestrator: { label: "Orchestrator", description: "main model, delegates work" },
	planner: { label: "Planner", description: "designs the approach, writes specs" },
	builder: { label: "Builder", description: "code implementation" },
	reviewer: { label: "Reviewer", description: "code review" },
	explorer: { label: "Explorer", description: "codebase exploration, research" },
	judge: { label: "Judge", description: "ferment verification and grading" },
}

const DELEGABLE_KEYS: (keyof ModelRoles)[] = ["planner", "builder", "reviewer", "explorer", "judge"]

const ROLE_KEYS: (keyof ModelRoles)[] = ["orchestrator", ...DELEGABLE_KEYS]

export function formatRoleAssignment(value: RoleModelAssignment): string {
	const models = normalizeRoleModels(value)
	return models.join(", ")
}

export function isEqualAssignment(a: RoleModelAssignment, b: RoleModelAssignment): boolean {
	const arrA = normalizeRoleModels(a)
	const arrB = normalizeRoleModels(b)
	return arrA.length === arrB.length && arrA.every((v, i) => v === arrB[i])
}

export function formatRoleDisplay(role: keyof ModelRoles, value: RoleModelAssignment): string {
	const info = ROLE_LABELS[role]
	const isDefault = isEqualAssignment(value, DEFAULT_MODEL_ROLES[role])
	const suffix = isDefault ? " (default)" : ""
	return `${info.label}: ${formatRoleAssignment(value)}${suffix}`
}

function hasBuiltinCapability(ref: string): boolean {
	const id = modelIdFromRef(ref)
	const entry = MODEL_CAPABILITIES.get(id)
	return entry !== undefined && entry !== "ignored"
}

function formatMetadataSnippet(ref: string): string {
	return `\n"modelRoles": {\n  "builder": [\n    "kimchi-dev/minimax-m2.7",\n    {\n      "model": "${ref}",\n      "tier": "heavy",\n      "description": "Describe this model's strengths...",\n      "vision": false\n    }\n  ]\n}\n`
}

function findModelRoleEntry(roles: ModelRoles, ref: string): { key: keyof ModelRoles; index: number } | undefined {
	for (const key of ROLE_KEYS) {
		const value = roles[key]
		if (Array.isArray(value)) {
			const idx = value.findIndex((item) => (typeof item === "string" ? item : item.model) === ref)
			if (idx !== -1) return { key, index: idx }
		} else if (typeof value === "string" && value === ref) {
			return { key, index: 0 }
		}
	}
	return undefined
}

export function registerModelRolesCommand(pi: ExtensionAPI): void {
	pi.registerCommand("multi-model", {
		description: "Configure model roles (orchestrator, planner, builder, reviewer, explorer, judge)",
		async handler(_args, ctx) {
			if (!ctx.hasUI) {
				ctx.ui.notify("Model roles configuration requires an interactive session.", "warning")
				return
			}

			const roles = { ...getModelRoles() }
			const customConfigs = extractCustomConfigs(roles)

			const apiModels = getAvailableModels()
			const availableModelRefs = apiModels.map((m) => `kimchi-dev/${m.slug}`)

			for (const key of ROLE_KEYS) {
				for (const ref of normalizeRoleModels(roles[key])) {
					if (!availableModelRefs.includes(ref)) {
						availableModelRefs.push(ref)
					}
				}
			}

			const showMainMenu = async (): Promise<void> => {
				const options = [
					...ROLE_KEYS.map((key) => formatRoleDisplay(key, roles[key])),
					"Add metadata to a model...",
					"Reset all to defaults",
				]

				const choice = await ctx.ui.select("Model Roles", options)
				if (!choice) return

				if (choice === "Reset all to defaults") {
					Object.assign(roles, DEFAULT_MODEL_ROLES)
					try {
						saveModelRoles(roles)
						syncOrchestratorRef(roles)
					} catch (err) {
						ctx.ui.notify(`Failed to save model roles: ${err instanceof Error ? err.message : err}`, "error")
						return
					}
					ctx.ui.notify("Model roles reset to defaults.", "info")

					// Switch the active model only if currently in multi-model mode
					if (getMultiModelEnabled()) {
						const parsed = splitModelRef(DEFAULT_MODEL_ROLES.orchestrator)
						if (parsed) {
							const target = ctx.modelRegistry?.find(parsed.provider, parsed.modelId)
							if (target) {
								try {
									await pi.setModel(target)
								} catch {
									ctx.ui.notify(
										`Could not switch to ${DEFAULT_MODEL_ROLES.orchestrator}. The model will be used next session.`,
										"warning",
									)
								}
							}
						}
					}
					return
				}

				if (choice === "Add metadata to a model...") {
					await showMetadataEditor()
					await showMainMenu()
					return
				}

				const roleIndex = ROLE_KEYS.findIndex((key) => choice === formatRoleDisplay(key, roles[key]))
				if (roleIndex === -1) return

				const roleKey = ROLE_KEYS[roleIndex]

				if (roleKey === "orchestrator") {
					await showSingleModelEditor(roleKey)
				} else {
					await showMultiModelEditor(roleKey)
				}
				await showMainMenu()
			}

			const showSingleModelEditor = async (roleKey: keyof ModelRoles): Promise<void> => {
				const info = ROLE_LABELS[roleKey]
				const currentModels = normalizeRoleModels(roles[roleKey])

				const modelOptions = availableModelRefs.map((ref) => {
					const isCurrent = currentModels.includes(ref)
					const defaultModels = normalizeRoleModels(DEFAULT_MODEL_ROLES[roleKey])
					const isDefault = defaultModels.includes(ref)
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
					const input = await ctx.ui.input("Model (provider/model-id):", currentModels[0] ?? "")
					if (!input?.trim()) return
					newRef = input.trim()

					if (!splitModelRef(newRef)) {
						ctx.ui.notify(
							`Invalid format: "${newRef}". Expected "provider/model-id" (e.g. "anthropic/claude-sonnet-4-5").`,
							"error",
						)
						return
					}

					const modelId = modelIdFromRef(newRef)
					const availableIds = new Set(apiModels.map((m) => m.slug))
					if (!availableIds.has(modelId)) {
						ctx.ui.notify(
							`Note: "${newRef}" is not in the available models list. It will be used if the provider is configured.`,
							"warning",
						)
					}
				} else {
					newRef = choice.replace(/\s*\(.*\)$/, "")
				}

				roles[roleKey] = newRef
				try {
					saveModelRoles(roles)
					syncOrchestratorRef(roles)
				} catch (err) {
					ctx.ui.notify(`Failed to save model roles: ${err instanceof Error ? err.message : err}`, "error")
					return
				}
				ctx.ui.notify(`${info.label} set to ${newRef}`, "info")

				// When the orchestrator role changes and multi-model is active,
				// switch the active model to the new orchestrator.
				if (roleKey === "orchestrator" && getMultiModelEnabled()) {
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

			const showMultiModelEditor = async (roleKey: keyof ModelRoles): Promise<void> => {
				const info = ROLE_LABELS[roleKey]
				const selected = new Set(normalizeRoleModels(roles[roleKey]))

				const buildToggleOptions = (): string[] => {
					const options = availableModelRefs.map((ref) => {
						const isSelected = selected.has(ref)
						const marker = isSelected ? "[x]" : "[ ]"
						return `${marker} ${ref}`
					})
					options.push("Add custom model...")
					options.push(`Done (${selected.size} selected)`)
					return options
				}

				// eslint-disable-next-line no-constant-condition
				while (true) {
					const choice = await ctx.ui.select(
						`${info.label} — toggle models (${selected.size} selected)`,
						buildToggleOptions(),
					)
					if (!choice) return

					if (choice.startsWith("Done")) {
						break
					}

					if (choice === "Add custom model...") {
						const input = await ctx.ui.input("Model (provider/model-id):")
						if (!input?.trim()) continue
						const ref = input.trim()

						if (!splitModelRef(ref)) {
							ctx.ui.notify(
								`Invalid format: "${ref}". Expected "provider/model-id" (e.g. "anthropic/claude-sonnet-4-5").`,
								"error",
							)
							continue
						}

						const modelId = modelIdFromRef(ref)
						const availableIds = new Set(apiModels.map((m) => m.slug))
						if (!availableIds.has(modelId)) {
							ctx.ui.notify(
								`Note: "${ref}" is not in the available models list. It will be used if the provider is configured.`,
								"warning",
							)
						}

						if (!availableModelRefs.includes(ref)) {
							availableModelRefs.push(ref)
						}
						selected.add(ref)
						continue
					}

					const ref = choice.replace(/^\[.\]\s*/, "").replace(/\s*\(.*\)$/, "")
					if (selected.has(ref)) {
						selected.delete(ref)
					} else {
						selected.add(ref)
					}
				}

				if (selected.size === 0) {
					ctx.ui.notify(`${info.label} must have at least one model. Keeping current assignment.`, "warning")
					return
				}

				const models = [...selected]
				const assignment: RoleModelAssignment = models.length === 1 ? models[0] : models
				;(roles as Record<string, RoleModelAssignment>)[roleKey] = assignment
				try {
					saveModelRoles(roles)
				} catch (err) {
					ctx.ui.notify(`Failed to save model roles: ${err instanceof Error ? err.message : err}`, "error")
					return
				}
				ctx.ui.notify(`${info.label} set to ${models.join(", ")}`, "info")
				encourageMetadataIfNeeded(models)
			}

			const encourageMetadataIfNeeded = (models: string[]) => {
				for (const ref of models) {
					if (!hasBuiltinCapability(ref) && !customConfigs.has(ref)) {
						ctx.ui.notify(
							`Tip: ${ref} has no built-in metadata. Add tier/description in settings.json to help the orchestrator route tasks. ${formatMetadataSnippet(ref)}`,
							"info",
						)
					}
				}
			}

			const showMetadataEditor = async (): Promise<void> => {
				// Collect all unique model refs across all roles
				const seen = new Set<string>()
				const modelOptions: string[] = []
				for (const key of ROLE_KEYS) {
					for (const ref of normalizeRoleModels(roles[key])) {
						if (!seen.has(ref)) {
							seen.add(ref)
							const config = customConfigs.get(ref)
							const annotation = config ? " (metadata ✓)" : ""
							modelOptions.push(`${ref}${annotation}`)
						}
					}
				}
				if (modelOptions.length === 0) {
					ctx.ui.notify("No models are currently configured.", "warning")
					return
				}
				modelOptions.push("Back")

				const choice = await ctx.ui.select("Choose a model to annotate", modelOptions)
				if (!choice || choice === "Back") return

				const ref = choice.replace(/\s*\(metadata.*\)$/, "")
				const existing = customConfigs.get(ref)

				// Tier
				const tierChoice = await ctx.ui.select("Tier", [
					"heavy",
					"standard",
					"light",
					existing?.tier ? `keep current (${existing.tier})` : "skip",
				])
				if (!tierChoice) return
				const tier = tierChoice.startsWith("keep current")
					? existing?.tier
					: tierChoice === "skip"
						? undefined
						: (tierChoice as "heavy" | "standard" | "light")

				// Vision
				const visionChoice = await ctx.ui.select("Vision support", [
					"yes",
					"no",
					existing?.vision !== undefined ? `keep current (${existing.vision ? "yes" : "no"})` : "skip",
				])
				if (!visionChoice) return
				const vision = visionChoice.startsWith("keep current")
					? existing?.vision
					: visionChoice === "skip"
						? undefined
						: visionChoice === "yes"

				// Description
				const descDefault = existing?.description ?? ""
				const descInput = await ctx.ui.input("Description (optional):", descDefault)
				const description = descInput?.trim() || existing?.description || undefined

				// Build config object, omitting undefined fields
				const config: CustomModelConfig = { model: ref }
				if (tier !== undefined) config.tier = tier
				if (vision !== undefined) config.vision = vision
				if (description !== undefined) config.description = description

				// Find the first role containing this model and convert to object
				const location = findModelRoleEntry(roles, ref)
				if (!location) {
					ctx.ui.notify(`Could not find ${ref} in any role.`, "error")
					return
				}

				const { key, index } = location
				const value = roles[key]
				if (Array.isArray(value)) {
					const item = value[index]
					if (typeof item === "string") {
						value[index] = config
					} else {
						Object.assign(item, config)
					}
				} else if (typeof value === "string") {
					;(roles as Record<string, RoleModelAssignment>)[key] = config
				}

				try {
					saveModelRoles(roles)
				} catch (err) {
					ctx.ui.notify(`Failed to save model roles: ${err instanceof Error ? err.message : err}`, "error")
					return
				}
				ctx.ui.notify(`Metadata saved for ${ref}.`, "info")
			}

			await showMainMenu()
		},
	})
}
