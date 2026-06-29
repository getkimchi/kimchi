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
import { type Question, type QuestionFormResult, YES_NO_OPTIONS, createQuestionForm } from "../questionnaire/index.js"
import {
	type ModelCustomMetadata,
	deleteModelMetadata,
	getModelMetadata,
	resolveModelMetadata,
	saveModelMetadata,
} from "./model-metadata.js"
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
	explorer: { label: "Explorer", description: "codebase exploration" },
	researcher: { label: "Researcher", description: "research beyond codebase, web search" },
	judge: { label: "Judge", description: "ferment verification and grading" },
}

const DELEGABLE_KEYS: (keyof ModelRoles)[] = ["planner", "builder", "reviewer", "explorer", "researcher", "judge"]

const ROLE_KEYS: (keyof ModelRoles)[] = ["orchestrator", ...DELEGABLE_KEYS]

/**
 * Whether `collectModelMetadata()` produced something worth persisting.
 *
 * Returns false for both `undefined` (user cancelled) and `{}` (user completed
 * the form but skipped every optional field). Saving an empty entry would
 * clutter settings.json with rows that `resolveModelMetadata()` ignores.
 */
export function hasMetadataContent(metadata: ModelCustomMetadata | undefined): metadata is ModelCustomMetadata {
	return metadata !== undefined && Object.keys(metadata).length > 0
}

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

export async function collectModelMetadata(
	ref: string,
	existing: ModelCustomMetadata | undefined,
	ctx: ExtensionCommandContext,
): Promise<ModelCustomMetadata | undefined> {
	// Sentinel option id for "leave this field as it currently is". When no
	// `existing` value is present the label collapses to plain "skip" so the
	// option reads naturally in both edit and create flows. A user picking
	// this option preserves whatever value is already in settings.json (or
	// leaves the field unset for create flows).
	const keepTierLabel = existing?.tier ? `keep current (${existing.tier})` : "skip"
	const keepVisionLabel = existing?.vision !== undefined ? `keep current (${existing.vision ? "yes" : "no"})` : "skip"

	const questions: Question[] = [
		{
			id: "tier",
			label: "Tier",
			prompt: `${ref}\nTier — what capability level is this model?`,
			type: "single",
			options: [
				{ id: "heavy", label: "heavy" },
				{ id: "standard", label: "standard" },
				{ id: "light", label: "light" },
				{ id: "__keep__", label: keepTierLabel },
			],
			allowOther: false,
			required: false,
		},
		{
			id: "vision",
			label: "Vision",
			prompt: `${ref}\nVision support — can this model process images?`,
			type: "single",
			options: [
				...YES_NO_OPTIONS.map((o) => ({ id: o.id, label: o.label })),
				{ id: "__keep__", label: keepVisionLabel },
			],
			allowOther: false,
			required: false,
		},
		{
			id: "description",
			label: "Description",
			prompt: `${ref}\nDescription — when should this model be used? (optional, leave blank to keep current)`,
			type: "text",
			options: [],
			allowOther: false,
			required: false,
		},
	]

	const result = await ctx.ui.custom<QuestionFormResult>((tui, theme, _kb, done) =>
		createQuestionForm(tui, theme, questions, { title: ref }, done),
	)
	if (result.cancelled) return undefined

	const byId = new Map(result.answers.map((a) => [a.id, a]))
	const config: ModelCustomMetadata = {}

	const tierAnswer = byId.get("tier")
	if (tierAnswer) {
		if (tierAnswer.value === "__keep__") {
			// User picked "keep current" / "skip" — only carry the existing tier
			// forward if there is one to carry.
			if (existing?.tier !== undefined) config.tier = existing.tier
		} else {
			config.tier = tierAnswer.value as "heavy" | "standard" | "light"
		}
	}

	const visionAnswer = byId.get("vision")
	if (visionAnswer) {
		if (visionAnswer.value === "__keep__") {
			if (existing?.vision !== undefined) config.vision = existing.vision
		} else {
			config.vision = visionAnswer.value === "yes"
		}
	}

	const descAnswer = byId.get("description")
	// The text-question reducer records "(no response)" when the user submits
	// an empty editor; treat that the same as "no answer recorded" so an
	// existing description is preserved unless the user types a replacement.
	const explicitDescription = descAnswer?.value && descAnswer.value !== "(no response)" ? descAnswer.value : undefined
	if (explicitDescription !== undefined) {
		config.description = explicitDescription
	} else if (existing?.description) {
		config.description = existing.description
	}

	return config
}

// ---------------------------------------------------------------------------
// Custom toggle-select component (space to toggle, Enter confirms, Esc cancels)
// ---------------------------------------------------------------------------

interface ToggleSelectResult {
	selected: Set<string>
	cancelled: boolean
}

function createToggleSelect(
	tui: TUI,
	theme: Theme,
	label: string,
	refs: string[],
	selected: Set<string>,
	done: (result: ToggleSelectResult) => void,
): Component {
	let cachedLines: string[] | undefined
	const cursor: { index: number } = { index: 0 }

	function handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			// Guard against empty refs — `% 0` is NaN in JS, which would
			// permanently break the cursor until the component is re-mounted.
			if (refs.length === 0) return
			cursor.index = (cursor.index - 1 + refs.length) % refs.length
			cachedLines = undefined
			tui.requestRender()
			return
		}
		if (matchesKey(data, Key.down)) {
			if (refs.length === 0) return
			cursor.index = (cursor.index + 1) % refs.length
			cachedLines = undefined
			tui.requestRender()
			return
		}
		if (data === " ") {
			const ref = refs[cursor.index]
			if (ref !== undefined) {
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
			done({ selected, cancelled: false })
			return
		}
		if (matchesKey(data, Key.escape)) {
			done({ selected, cancelled: true })
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
		// The title embeds the current selection count, so it must be built
		// inside render() rather than interpolated at call-time. Otherwise
		// Space toggles update the footer count but leave the title frozen
		// at the initial value (a confusing cosmetic mismatch).
		const title = `${label} — toggle models (${selected.size} selected)`
		add(` ${theme.fg("text", theme.bold(title))}`)
		lines.push("")

		for (let i = 0; i < refs.length; i++) {
			const isCursor = i === cursor.index
			const prefix = isCursor ? theme.fg("accent", "> ") : "  "

			const ref = refs[i]
			const checked = selected.has(ref)
			const box = checked ? "[x]" : "[ ]"
			const color = isCursor ? "accent" : "text"
			add(`${prefix}${theme.fg(color, `${box} ${ref}`)}`)
		}

		lines.push("")
		add(
			theme.fg(
				"dim",
				` \u2191\u2193 navigate \u00b7 space toggle \u00b7 \u23ce confirm (${selected.size} selected) \u00b7 esc cancel`,
			),
		)
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
		description: "Configure model roles (orchestrator, planner, builder, reviewer, explorer, researcher, judge)",
		async handler(_args, ctx) {
			if (!ctx.hasUI) {
				ctx.ui.notify("Model roles configuration requires an interactive session.", "warning")
				return
			}

			const roles = { ...getModelRoles() }

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

				// No cursor preservation: the menu reopens from row 0 every
				// time, which is what users expect when re-entering a fresh
				// selection screen.
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

				const choice = await ctx.ui.select(`${info.label} — ${info.description}`, modelOptions)
				if (!choice) return

				const newRef = choice.replace(/\s*\(.*\)$/, "")

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
			}

			const showMultiModelEditor = async (roleKey: keyof ModelRoles): Promise<void> => {
				const info = ROLE_LABELS[roleKey]
				const selected = new Set(normalizeRoleModels(roles[roleKey]))

				const result = await ctx.ui.custom<ToggleSelectResult>((tui, theme, _kb, done) =>
					createToggleSelect(tui, theme, info.label, availableModelRefs, selected, done),
				)

				if (result.cancelled) return

				// Read from result.selected (the Set the component returned)
				// rather than the outer closure variable. Today they are the
				// same object — the picker mutates the Set in place — but
				// reading from the result makes the dependency explicit and
				// keeps the contract intact if the component ever switches to
				// cloning the Set before resolving.
				const finalSelected = result.selected
				if (finalSelected.size === 0) {
					ctx.ui.notify(`${info.label} must have at least one model. Keeping current assignment.`, "warning")
					return
				}

				const models = [...finalSelected]
				const assignment: RoleModelAssignment = models.length === 1 ? models[0] : models
				;(roles as Record<string, RoleModelAssignment>)[roleKey] = assignment
				try {
					saveModelRoles(roles)
				} catch (err) {
					ctx.ui.notify(`Failed to save model roles: ${err instanceof Error ? err.message : err}`, "error")
					return
				}
				ctx.ui.notify(`${info.label} set to ${models.join(", ")}`, "info")
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

				const hasCustomOverride = existing?.source === "custom"
				const actionOptions = hasCustomOverride ? ["Edit", "Reset to defaults", "Cancel"] : ["Edit", "Cancel"]
				const action = await ctx.ui.select(`${ref} — metadata`, actionOptions)
				if (!action || action === "Cancel") return

				if (action === "Reset to defaults") {
					deleteModelMetadata(ref)
					ctx.ui.notify(`Custom metadata removed for ${ref}.`, "info")
					return
				}

				const metadata = await collectModelMetadata(ref, existingMeta, ctx)
				if (!hasMetadataContent(metadata)) {
					ctx.ui.notify(`No metadata saved for ${ref}.`, "info")
					return
				}

				const map = new Map<string, ModelCustomMetadata>()
				map.set(ref, metadata)
				saveModelMetadata(map)
				ctx.ui.notify(`Metadata saved for ${ref}.`, "info")
			}

			await showMainMenu()
		},
	})
}
