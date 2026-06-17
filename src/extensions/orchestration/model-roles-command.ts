/**
 * /models slash command — interactive model role configuration.
 *
 * Shows the current role assignments and lets the user change them
 * by selecting from available models. Changes are persisted to
 * ~/.config/kimchi/harness/settings.json.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent"
import { Key, type TUI, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import type { Component } from "@earendil-works/pi-tui"
import { getAvailableModels } from "../../startup-context.js"
import { setProcessOrchestratorRef } from "../kimchi-process.js"
import { withSuppressedModelSelectGuard } from "../model-switch.js"
import { getMultiModelEnabled } from "../prompt-construction/prompt-enrichment.js"
import {
	type ModelCustomMetadata,
	getModelMetadata,
	isModelMetadataMissing,
	resolveModelMetadata,
	saveModelMetadata,
} from "./model-metadata.js"
import { MODEL_CAPABILITIES } from "./model-registry/builtin-models.js"
import {
	DEFAULT_MODEL_ROLES,
	type ModelRoles,
	type RoleModelAssignment,
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

export function formatRoleSummaryBlock(role: keyof ModelRoles, value: RoleModelAssignment): string {
	const info = ROLE_LABELS[role]
	const models = normalizeRoleModels(value)
	const isDefault = isEqualAssignment(value, DEFAULT_MODEL_ROLES[role])

	const indent = "    "
	const modelLines = models.map((ref) => {
		const suffix = isDefault ? " (default)" : ""
		return `${indent}${ref}${suffix}`
	})

	return `${info.label}:\n${modelLines.join("\n")}`
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

function shouldPromptForMetadata(ref: string): boolean {
	if (hasBuiltinCapability(ref)) return false
	return isModelMetadataMissing(ref)
}

export async function collectModelMetadata(
	ref: string,
	existing: ModelCustomMetadata | undefined,
	ctx: ExtensionCommandContext,
): Promise<ModelCustomMetadata | undefined> {
	const tierOptions = ["heavy", "standard", "light"]
	if (existing?.tier) {
		tierOptions.push(`keep current (${existing.tier})`)
	} else {
		tierOptions.push("skip")
	}
	const tierChoice = await ctx.ui.select(
		`${ref}\nSpecifying metadata will improve orchestration.\nTier - what capability level is this model?`,
		tierOptions,
	)
	if (!tierChoice) return undefined
	const tier = tierChoice.startsWith("keep current")
		? existing?.tier
		: tierChoice === "skip"
			? undefined
			: (tierChoice as "heavy" | "standard" | "light")

	const visionOptions = ["yes", "no"]
	if (existing?.vision !== undefined) {
		visionOptions.push(`keep current (${existing.vision ? "yes" : "no"})`)
	} else {
		visionOptions.push("skip")
	}
	const visionChoice = await ctx.ui.select(`${ref}\nVision support - can this model process images?`, visionOptions)
	if (!visionChoice) return undefined
	const vision = visionChoice.startsWith("keep current")
		? existing?.vision
		: visionChoice === "skip"
			? undefined
			: visionChoice === "yes"

	const descDefault = existing?.description ?? ""
	const descInput = await ctx.ui.input(`${ref}\nDescription - when should this model be used? (optional):`, descDefault)
	if (descInput === undefined) return undefined
	const description = descInput.trim() || existing?.description || undefined

	const config: ModelCustomMetadata = {}
	if (tier !== undefined) config.tier = tier
	if (vision !== undefined) config.vision = vision
	if (description !== undefined) config.description = description
	return config
}

async function promptMetadataWizard(
	ref: string,
	ctx: ExtensionCommandContext,
	configuredThisSession: Set<string>,
): Promise<void> {
	if (configuredThisSession.has(ref)) return

	const wizardChoice = await ctx.ui.select(
		`${ref}\nThis model has no metadata (tier, description, vision).\nSpecifying metadata will improve orchestration.`,
		["Configure now", "Skip"],
	)
	if (wizardChoice !== "Configure now") {
		configuredThisSession.add(ref)
		return
	}

	const metadata = await collectModelMetadata(ref, resolveModelMetadata(ref) ?? undefined, ctx)
	if (metadata && Object.keys(metadata).length > 0) {
		const map = new Map<string, ModelCustomMetadata>()
		map.set(ref, metadata)
		saveModelMetadata(map)
		ctx.ui.notify(`Metadata saved for ${ref}.`, "info")
	}
	configuredThisSession.add(ref)
}

// ---------------------------------------------------------------------------
// Custom toggle-select component (space to toggle, cursor preserved)
// ---------------------------------------------------------------------------

interface ToggleSelectResult {
	selected: Set<string>
	cancelled: boolean
	addCustom: boolean
}

function createToggleSelect(
	tui: TUI,
	theme: Theme,
	title: string,
	refs: string[],
	selected: Set<string>,
	done: (result: ToggleSelectResult) => void,
): Component {
	let cursorIndex = 0
	let cachedLines: string[] | undefined

	const ADD_CUSTOM = "Add custom model..."
	const doneLabel = () => `Done (${selected.size} selected)`
	const allItems = (): string[] => [...refs, ADD_CUSTOM, doneLabel()]

	function handleInput(data: string): void {
		const items = allItems()

		if (matchesKey(data, Key.up)) {
			cursorIndex = (cursorIndex - 1 + items.length) % items.length
			cachedLines = undefined
			tui.requestRender()
			return
		}
		if (matchesKey(data, Key.down)) {
			cursorIndex = (cursorIndex + 1) % items.length
			cachedLines = undefined
			tui.requestRender()
			return
		}
		if (data === " ") {
			if (cursorIndex < refs.length) {
				const ref = refs[cursorIndex]
				if (selected.has(ref)) {
					selected.delete(ref)
				} else {
					selected.add(ref)
				}
				cachedLines = undefined
				tui.requestRender()
			}
			return
		}
		if (matchesKey(data, Key.enter)) {
			const item = items[cursorIndex]
			if (item === ADD_CUSTOM) {
				done({ selected, cancelled: false, addCustom: true })
				return
			}
			done({ selected, cancelled: false, addCustom: false })
			return
		}
		if (matchesKey(data, Key.escape)) {
			done({ selected, cancelled: true, addCustom: false })
			return
		}
	}

	function render(width: number): string[] {
		if (cachedLines) return cachedLines

		const lines: string[] = []
		const add = (s: string) => {
			for (const line of wrapTextWithAnsi(s, width)) {
				lines.push(line)
			}
		}

		add(theme.fg("accent", "\u2500".repeat(width)))
		add(` ${theme.fg("text", theme.bold(title))}`)
		lines.push("")

		const items = allItems()
		for (let i = 0; i < items.length; i++) {
			const isCursor = i === cursorIndex
			const prefix = isCursor ? theme.fg("accent", "> ") : "  "

			if (i < refs.length) {
				const ref = refs[i]
				const checked = selected.has(ref)
				const box = checked ? "[x]" : "[ ]"
				const color = isCursor ? "accent" : "text"
				add(`${prefix}${theme.fg(color, `${box} ${ref}`)}`)
			} else {
				const color = isCursor ? "accent" : "text"
				add(`${prefix}${theme.fg(color, items[i])}`)
			}
		}

		lines.push("")
		add(theme.fg("dim", " \u2191\u2193 navigate  space toggle  enter confirm  esc cancel"))
		add(theme.fg("accent", "\u2500".repeat(width)))

		cachedLines = lines
		return lines
	}

	return {
		render,
		invalidate: () => {
			cachedLines = undefined
		},
		handleInput,
	}
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
			const configuredThisSession = new Set<string>()

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
				const roleOptions = ROLE_KEYS.map((key) => formatRoleSummaryBlock(key, roles[key]))
				const options = [...roleOptions, "Edit model metadata...", "Reset all to defaults"]

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

					if (getMultiModelEnabled()) {
						const parsed = splitModelRef(DEFAULT_MODEL_ROLES.orchestrator)
						if (parsed) {
							const target = ctx.modelRegistry?.find(parsed.provider, parsed.modelId)
							if (target) {
								try {
									await withSuppressedModelSelectGuard(() => pi.setModel(target))
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

				if (choice === "Edit model metadata...") {
					await showMetadataEditor()
					await showMainMenu()
					return
				}

				const roleIndex = ROLE_KEYS.findIndex((key) => choice === formatRoleSummaryBlock(key, roles[key]))
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

				if (roleKey === "orchestrator" && getMultiModelEnabled()) {
					const parsed = splitModelRef(newRef)
					if (parsed) {
						const target = ctx.modelRegistry?.find(parsed.provider, parsed.modelId)
						if (target) {
							try {
								await withSuppressedModelSelectGuard(() => pi.setModel(target))
							} catch {
								ctx.ui.notify(`Could not switch to ${newRef}. The model will be used next session.`, "warning")
							}
						}
					}
				}

				if (shouldPromptForMetadata(newRef)) {
					await promptMetadataWizard(newRef, ctx, configuredThisSession)
				}
			}

			const showMultiModelEditor = async (roleKey: keyof ModelRoles): Promise<void> => {
				const info = ROLE_LABELS[roleKey]
				const previousModels = new Set(normalizeRoleModels(roles[roleKey]))
				const selected = new Set(previousModels)

				// eslint-disable-next-line no-constant-condition
				while (true) {
					const result = await ctx.ui.custom<ToggleSelectResult>((tui, theme, _kb, done) =>
						createToggleSelect(
							tui,
							theme,
							`${info.label} — toggle models (${selected.size} selected)`,
							availableModelRefs,
							selected,
							done,
						),
					)

					if (result.cancelled) return

					if (result.addCustom) {
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

					break
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

				const newlyAdded = models.filter((ref) => !previousModels.has(ref))
				for (const ref of newlyAdded) {
					if (shouldPromptForMetadata(ref)) {
						await promptMetadataWizard(ref, ctx, configuredThisSession)
					}
				}
			}

			const showMetadataEditor = async (): Promise<void> => {
				const globalMeta = getModelMetadata()

				const seen = new Set<string>()
				const modelOptions: string[] = []

				for (const ref of globalMeta.keys()) {
					if (!seen.has(ref)) {
						seen.add(ref)
						modelOptions.push(ref)
					}
				}

				for (const key of ROLE_KEYS) {
					for (const ref of normalizeRoleModels(roles[key])) {
						if (!seen.has(ref)) {
							seen.add(ref)
							const resolved = resolveModelMetadata(ref)
							const annotation =
								resolved?.source === "custom"
									? ""
									: resolved?.source === "builtin"
										? " (default)"
										: " (missing metadata)"
							modelOptions.push(`${ref}${annotation}`)
						}
					}
				}

				if (modelOptions.length === 0) {
					ctx.ui.notify("No models are currently configured.", "warning")
					return
				}
				modelOptions.push("Back")

				const choice = await ctx.ui.select("Choose a model to edit metadata", modelOptions)
				if (!choice || choice === "Back") return

				const ref = choice.replace(/\s*\(default\)$/, "").replace(/\s*\(missing metadata\)$/, "")
				const existing = resolveModelMetadata(ref)
				const existingMeta: ModelCustomMetadata | undefined = existing
					? { tier: existing.tier, description: existing.description, vision: existing.vision }
					: undefined

				const metadata = await collectModelMetadata(ref, existingMeta, ctx)
				if (!metadata) return

				const map = new Map<string, ModelCustomMetadata>()
				map.set(ref, metadata)
				saveModelMetadata(map)
				ctx.ui.notify(`Metadata saved for ${ref}.`, "info")
			}

			await showMainMenu()
		},
	})
}
