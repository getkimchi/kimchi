import type { Component } from "@earendil-works/pi-tui"
import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { fg } from "../../../ansi.js"
import { resolveWorkspaceSpec, WorkspaceSpecError } from "../../../sandbox/cloud/spec.js"
import type {
	EgressPolicyConfig,
	WorkspaceResourcesConfig,
	WorkspaceSpecConfig,
	WorkspaceTemplateSummary,
} from "../../../sandbox/cloud/types.js"
import type { WorkspaceFileConfig } from "../../../sandbox/cloud/workspace-file.js"
import { truncateLinesToWidth } from "../../../truncate-lines.js"
import type { TeleportContext } from "../types.js"

// ── State ────────────────────────────────────────────────────────────────────

/**
 * Tri-state for the egress `denyByDefault` posture: "inherit" leaves the
 * field unset (server default — currently fail-closed), `true` requests
 * deny-by-default, `false` explicitly requests default-allow.
 */
export type DenyByDefaultChoice = "inherit" | boolean

export type WorkspaceSetupFieldId =
	| "template"
	| "name"
	| "cpu"
	| "memory"
	| "pvcSize"
	| "dependencies"
	| "denyByDefault"
	| "allowed"
	| "denied"

export interface WorkspaceSetupFieldState {
	id: WorkspaceSetupFieldId
	label: string
	/** Text fields: the raw edited string. Choice fields always carry "". */
	value: string
	/** Only set on the denyByDefault field. */
	choice?: DenyByDefaultChoice
	placeholder: string
}

export interface WorkspaceSetupPrefill {
	/** Initial workspace display name (cwd basename in practice). */
	name: string
	/** Values parsed from `kimchi_workspace.yaml`, when one was found. */
	file?: WorkspaceFileConfig
}

/**
 * Searchable template picker, opened from the Template field. The filtered
 * list always leads with the "(none)" row — selecting it clears the template
 * so the manual configuration fields apply again.
 */
export interface WorkspaceSetupPickerState {
	query: string
	/** Index into the filtered list (0 = none/manual). */
	selected: number
}

/**
 * One-page setup form. The Template field (present only when the org has
 * templates) selects an org template — the server then expands its values at
 * creation time and the manual resource/dependency/egress fields are ignored
 * (templateName and spec are mutually exclusive on the wire). With no
 * template selected the manual fields assemble the spec. The field values are
 * kept while a template is selected, so clearing the template restores them.
 */
export interface WorkspaceSetupState {
	fields: WorkspaceSetupFieldState[]
	/** Index into `fields`; the action row sits at index `fields.length`. */
	selected: number
	editing: boolean
	/** Open while choosing a template from the Template field. */
	picker?: WorkspaceSetupPickerState
	/** Aggregated validation violations from the last submit attempt. */
	error?: string
	templates: WorkspaceTemplateSummary[]
	prefill: WorkspaceSetupPrefill
}

export type WorkspaceSetupResult =
	| { action: "create"; name?: string; spec?: WorkspaceSpecConfig; templateName?: string }
	| { action: "cancel" }

export const TEMPLATE_NONE_LABEL = "(none — manual configuration)"

function manualFields(prefill: WorkspaceSetupPrefill): WorkspaceSetupFieldState[] {
	const f = prefill.file
	return [
		{ id: "name", label: "Name", value: prefill.name, placeholder: "(workspace name)" },
		{ id: "cpu", label: "CPU", value: f?.resources?.cpu ?? "", placeholder: "(org default)" },
		{ id: "memory", label: "Memory", value: f?.resources?.memory ?? "", placeholder: "(org default)" },
		{ id: "pvcSize", label: "PVC size", value: f?.resources?.pvcSize ?? "", placeholder: "(org default)" },
		{
			id: "dependencies",
			label: "Dependencies",
			value: f?.dependencies?.join(", ") ?? "",
			placeholder: "(none) e.g. jq, node@22",
		},
		{
			id: "denyByDefault",
			label: "Egress mode",
			value: "",
			choice: f?.egressPolicy?.denyByDefault ?? "inherit",
			placeholder: "",
		},
		{
			id: "allowed",
			label: "Egress allowed",
			value: f?.egressPolicy?.allowed?.join(", ") ?? "",
			placeholder: "(none) e.g. github.com:443",
		},
		{
			id: "denied",
			label: "Egress denied",
			value: f?.egressPolicy?.denied?.join(", ") ?? "",
			placeholder: "(none) e.g. 10.0.0.0/8",
		},
	]
}

/**
 * Initial dialog state. The Template field leads the form only when the org
 * catalog is non-empty — with no templates it would be a pointless extra
 * keystroke, so the form is the plain manual configuration.
 */
export function initialWorkspaceSetupState(
	prefill: WorkspaceSetupPrefill,
	templates: WorkspaceTemplateSummary[] = [],
): WorkspaceSetupState {
	const fields: WorkspaceSetupFieldState[] =
		templates.length > 0
			? [{ id: "template", label: "Template", value: "", placeholder: TEMPLATE_NONE_LABEL }, ...manualFields(prefill)]
			: manualFields(prefill)
	return { fields, selected: 0, editing: false, templates, prefill }
}

// ── Events ───────────────────────────────────────────────────────────────────

export type WorkspaceSetupEvent =
	| { kind: "char"; char: string }
	| { kind: "backspace" }
	| { kind: "up" }
	| { kind: "down" }
	| { kind: "tab" }
	| { kind: "enter" }
	| { kind: "cancel" }

/**
 * Map raw terminal input to a setup-dialog event.
 * Returns undefined for unrecognised input (the caller should ignore it).
 */
export function keyToWorkspaceSetupEvent(data: string): WorkspaceSetupEvent | undefined {
	if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return { kind: "cancel" }
	if (matchesKey(data, Key.enter)) return { kind: "enter" }
	if (matchesKey(data, Key.tab)) return { kind: "tab" }
	if (matchesKey(data, Key.up)) return { kind: "up" }
	if (matchesKey(data, Key.down)) return { kind: "down" }
	if (matchesKey(data, Key.backspace)) return { kind: "backspace" }

	// Bracketed paste: strip markers and treat contents as characters
	let cleaned = data
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (0x1b) is the escape code introducing bracketed paste
	if (cleaned.includes("\x1b[200~")) cleaned = cleaned.replace(/\x1b\[200~/g, "")
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (0x1b) is the escape code terminating bracketed paste
	if (cleaned.includes("\x1b[201~")) cleaned = cleaned.replace(/\x1b\[201~/g, "")

	// Accept printable characters (reject control chars)
	const hasControlChars = [...cleaned].some((ch) => {
		const code = ch.charCodeAt(0)
		return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
	})
	if (!hasControlChars && cleaned.length > 0) {
		return { kind: "char", char: cleaned }
	}

	return undefined
}

// ── Template filtering ───────────────────────────────────────────────────────

/**
 * The picker's option list: the "(none)" row always leads, then templates
 * matching the query (case-insensitive substring against name and
 * description) in catalog order.
 */
export function filteredTemplateOptions(
	templates: WorkspaceTemplateSummary[],
	query: string,
): Array<{ kind: "none" } | { kind: "template"; template: WorkspaceTemplateSummary }> {
	const q = query.trim().toLowerCase()
	const matches = templates.filter(
		(t) => q.length === 0 || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
	)
	return [{ kind: "none" }, ...matches.map((template) => ({ kind: "template" as const, template }))]
}

// ── Spec assembly ────────────────────────────────────────────────────────────

/** Comma-separated one-liner → trimmed, non-empty entries (order preserved). */
export function splitListField(raw: string): string[] {
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

export function denyByDefaultLabel(choice: DenyByDefaultChoice): string {
	if (choice === "inherit") return "(server default)"
	return choice === true ? "deny by default" : "allow by default"
}

/**
 * Assemble the manual configuration fields into a `WorkspaceFileConfig`
 * shape and run the shared `resolveWorkspaceSpec` validator — one source of
 * truth for quantity, dependency, and egress grammar. Empty fields are
 * omitted (org defaults); violations come back as a displayable message
 * instead of a throw. Never called when a template is selected (the server
 * expands the template; templateName and spec are mutually exclusive).
 */
export function assembleWorkspaceSpec(state: Pick<WorkspaceSetupState, "fields">): {
	spec?: WorkspaceSpecConfig
	name?: string
	error?: string
} {
	const textOf = (id: WorkspaceSetupFieldId): string => (state.fields.find((f) => f.id === id)?.value ?? "").trim()

	const name = textOf("name") || undefined

	const resources: WorkspaceResourcesConfig = {}
	for (const [id, field] of [
		["cpu", "cpu"],
		["memory", "memory"],
		["pvcSize", "pvcSize"],
	] as const) {
		const value = textOf(id)
		if (value) resources[field] = value
	}

	const dependencies = splitListField(textOf("dependencies"))
	const deny = state.fields.find((f) => f.id === "denyByDefault")?.choice ?? "inherit"
	const allowed = splitListField(textOf("allowed"))
	const denied = splitListField(textOf("denied"))

	const egressPolicy: EgressPolicyConfig | undefined =
		deny !== "inherit" || allowed.length > 0 || denied.length > 0
			? {
					...(deny !== "inherit" ? { denyByDefault: deny } : {}),
					...(allowed.length > 0 ? { allowed } : {}),
					...(denied.length > 0 ? { denied } : {}),
				}
			: undefined

	const fileConfig: WorkspaceFileConfig = {}
	if (Object.keys(resources).length > 0) fileConfig.resources = resources
	if (dependencies.length > 0) fileConfig.dependencies = dependencies
	if (egressPolicy) fileConfig.egressPolicy = egressPolicy

	try {
		return { name, spec: resolveWorkspaceSpec(fileConfig) }
	} catch (err) {
		if (err instanceof WorkspaceSpecError) return { name, error: err.message }
		throw err
	}
}

// ── Reduction ────────────────────────────────────────────────────────────────

function moveSelection(state: WorkspaceSetupState, delta: number): WorkspaceSetupState {
	const max = state.fields.length // last selectable index = action row
	const selected = Math.min(max, Math.max(0, state.selected + delta))
	return { ...state, selected, editing: false }
}

function cycleDenyByDefault(state: WorkspaceSetupState): WorkspaceSetupState {
	const fields = state.fields.map((f) => {
		if (f.id !== "denyByDefault" || f.choice === undefined) return f
		const next: DenyByDefaultChoice = f.choice === "inherit" ? true : f.choice === true ? false : "inherit"
		return { ...f, choice: next }
	})
	return { ...state, fields }
}

function editText(state: WorkspaceSetupState, mutate: (value: string) => string): WorkspaceSetupState {
	const fields = state.fields.map((f, i) => (i === state.selected ? { ...f, value: mutate(f.value) } : f))
	return { ...state, fields }
}

/** The Template field is a choice field — its value is only set via the picker. */
function selectedField(state: WorkspaceSetupState): WorkspaceSetupFieldState | undefined {
	return state.fields[state.selected]
}

/** Whether a workspace template is currently selected (manual fields read-only). */
function templateActive(state: WorkspaceSetupState): boolean {
	return (state.fields.find((f) => f.id === "template")?.value.trim().length ?? 0) > 0
}

/** The template currently selected in the Template field, if any. */
export function selectedTemplate(state: WorkspaceSetupState): WorkspaceTemplateSummary | undefined {
	const name = state.fields.find((f) => f.id === "template")?.value.trim()
	if (!name) return undefined
	return state.templates.find((t) => t.name === name)
}

/**
 * The manual fields a selected template overrides, with its preset values.
 * Undefined when the template doesn't set that dimension (the workspace
 * inherits the org default; the field stays read-only regardless).
 */
export function templateFieldValue(
	field: WorkspaceSetupFieldId,
	template: WorkspaceTemplateSummary,
): string | undefined {
	const spec = template.spec
	if (!spec) return undefined
	switch (field) {
		case "cpu":
			return spec.resources?.cpu
		case "memory":
			return spec.resources?.memory
		case "pvcSize":
			return spec.resources?.pvcSize
		case "dependencies":
			return spec.dependencies?.length ? spec.dependencies.join(", ") : undefined
		case "denyByDefault":
			return denyByDefaultLabel(spec.egressPolicy?.denyByDefault ?? "inherit")
		case "allowed":
			return spec.egressPolicy?.allowed?.length ? spec.egressPolicy.allowed.join(", ") : undefined
		case "denied":
			return spec.egressPolicy?.denied?.length ? spec.egressPolicy.denied.join(", ") : undefined
		default:
			return undefined
	}
}

/**
 * Pure state machine for the setup dialog. Never throws: submit validation
 * failures land back into `state.error` and keep the dialog open.
 *
 * The Template field opens the searchable picker; `enter` applies the
 * highlighted option, `tab` applies it and moves on to the next field, `esc`
 * closes the picker without changing the selection. Esc outside the picker
 * leaves an active edit first and cancels the dialog otherwise.
 */
export function reduceWorkspaceSetup(
	state: WorkspaceSetupState,
	event: WorkspaceSetupEvent,
): { state: WorkspaceSetupState; result?: WorkspaceSetupResult } {
	// ── Template picker (open) ──
	if (state.picker) {
		const options = filteredTemplateOptions(state.templates, state.picker.query)
		const apply = (s: WorkspaceSetupState, moveOn: boolean): WorkspaceSetupState => {
			const picker = s.picker
			if (!picker) return s
			const option = options[Math.min(picker.selected, options.length - 1)]
			const fields = s.fields.map((f) =>
				f.id === "template" ? { ...f, value: option?.kind === "template" ? option.template.name : "" } : f,
			)
			return {
				...s,
				fields,
				picker: undefined,
				selected: moveOn ? Math.min(s.selected + 1, s.fields.length) : s.selected,
				editing: false,
			}
		}
		switch (event.kind) {
			case "char":
				return {
					state: {
						...state,
						picker: {
							query: state.picker.query + event.char,
							selected: 0,
						},
					},
				}
			case "backspace":
				return {
					state: {
						...state,
						picker: { query: state.picker.query.slice(0, -1), selected: 0 },
					},
				}
			case "up":
				return {
					state: {
						...state,
						picker: { ...state.picker, selected: Math.max(0, state.picker.selected - 1) },
					},
				}
			case "down":
				return {
					state: {
						...state,
						picker: {
							...state.picker,
							selected: Math.min(options.length - 1, state.picker.selected + 1),
						},
					},
				}
			case "enter":
				return { state: apply(state, false) }
			case "tab":
				return { state: apply(state, true) }
			case "cancel":
				return { state: { ...state, picker: undefined } }
		}
	}

	// ── Form ──
	switch (event.kind) {
		case "up":
			return { state: moveSelection(state, -1) }
		case "down":
		case "tab":
			return { state: moveSelection(state, 1) }
		case "backspace":
			if (!state.editing) return { state }
			return { state: editText(state, (v) => v.slice(0, -1)) }
		case "char":
			if (!state.editing) return { state }
			return { state: editText(state, (v) => v + event.char) }
		case "enter": {
			// Editing → commit and move on (fast top-to-bottom fill).
			if (state.editing) return { state: moveSelection(state, 1) }
			if (state.selected >= state.fields.length) {
				const templateName = (state.fields.find((f) => f.id === "template")?.value ?? "").trim()
				const name = (state.fields.find((f) => f.id === "name")?.value ?? "").trim() || undefined
				if (templateName) {
					// The server expands the template at creation; the manual
					// fields are ignored (templateName and spec never ride the
					// same request).
					return {
						state: { ...state, editing: false, error: undefined },
						result: { action: "create", name, templateName },
					}
				}
				const { name: assembledName, spec, error } = assembleWorkspaceSpec(state)
				if (error) return { state: { ...state, editing: false, error } }
				return {
					state: { ...state, editing: false, error: undefined },
					result: { action: "create", name: assembledName, spec },
				}
			}
			const field = selectedField(state)
			if (field?.id === "template") {
				// Open the searchable picker; typing filters, enter applies.
				return { state: { ...state, picker: { query: "", selected: 0 } } }
			}
			// While a template is selected the manual configuration fields are
			// read-only: the server expands the template's values at creation and
			// ignores these fields (templateName and spec never ride the same
			// request). Name stays editable — it is the workspace's own display
			// name, not a template value.
			if (templateActive(state) && field?.id !== "name") return { state }
			if (field?.id === "denyByDefault") return { state: cycleDenyByDefault(state) }
			return { state: { ...state, editing: true } }
		}
		case "cancel":
			// Esc while editing just leaves the field; a second Esc closes.
			if (state.editing) return { state: { ...state, editing: false } }
			return { state, result: { action: "cancel" } }
	}
}

// ── Component ────────────────────────────────────────────────────────────────

// Fixed reserved block for submit-validation errors — the dialog always emits
// the same line count regardless of error presence, which keeps the pi-tui
// overlay compositor from shifting the chat content underneath. Overflow is
// truncated with an ellipsis; the next submit re-reports remaining violations.
const ERROR_LINES = 4

// Visible picker rows (filter line and hint are extra, fixed).
const PICKER_MAX_VISIBLE = 8

interface SetupTui {
	requestRender(force?: boolean): void
}

function dim(s: string): string {
	return `\x1b[2m${s}\x1b[22m`
}

function pad(s: string, width: number): string {
	if (s.length >= width) return s
	return s + " ".repeat(width - s.length)
}

function truncate(s: string, width: number): string {
	if (s.length <= width) return s
	if (width <= 1) return s.slice(0, width)
	return `${s.slice(0, width - 1)}…`
}

function visibleWindow(selected: number, total: number, maxVisible: number): { start: number; end: number } {
	if (total <= maxVisible) return { start: 0, end: total }
	const half = Math.floor(maxVisible / 2)
	let start = selected - half
	if (start < 0) start = 0
	if (start + maxVisible > total) start = total - maxVisible
	return { start, end: start + maxVisible }
}

export class WorkspaceSetupPanel implements Component {
	private state: WorkspaceSetupState

	constructor(
		prefill: WorkspaceSetupPrefill,
		templates: WorkspaceTemplateSummary[],
		private readonly tui: SetupTui,
		private readonly done: (result: WorkspaceSetupResult | undefined) => void,
	) {
		this.state = initialWorkspaceSetupState(prefill, templates)
	}

	handleInput(data: string): void {
		const event = keyToWorkspaceSetupEvent(data)
		if (!event) return
		const { state, result } = reduceWorkspaceSetup(this.state, event)
		this.state = state
		this.tui.requestRender()
		if (result) {
			this.done(result)
		}
	}

	render(width: number): string[] {
		const b = (s: string) => fg("2", s)
		const innerW = Math.max(1, width - 2)
		const contentW = Math.max(1, innerW - 2)

		const lines: string[] = []

		const titleText = " New workspace "
		const borderLen = Math.max(0, innerW - titleText.length)
		const leftB = Math.floor(borderLen / 2)
		const rightB = borderLen - leftB
		lines.push(`${b(`╭${"─".repeat(leftB)}`)}${dim(truncate(titleText, innerW))}${b(`${"─".repeat(rightB)}╮`)}`)

		const ansiRow = (content: string, rawLen: number) =>
			`${b("│")} ${content}${" ".repeat(Math.max(0, contentW - rawLen))} ${b("│")}`

		if (this.state.picker) {
			lines.push(...this.renderPicker(contentW, ansiRow))
		} else {
			lines.push(...this.renderForm(contentW, ansiRow))
		}

		lines.push(b(`╰${"─".repeat(innerW)}╯`))

		return truncateLinesToWidth(lines, width)
	}

	private renderPicker(contentW: number, ansiRow: (content: string, rawLen: number) => string): string[] {
		const picker = this.state.picker
		if (!picker) return []
		const options = filteredTemplateOptions(this.state.templates, picker.query)
		const { start, end } = visibleWindow(picker.selected, options.length, PICKER_MAX_VISIBLE)

		const lines: string[] = []

		const queryCell = truncate(`Filter: ${picker.query}█`, Math.max(1, contentW - 2))
		lines.push(ansiRow(`  ${queryCell}`, 2 + queryCell.length))

		for (let i = start; i < end; i++) {
			const option = options[i]
			if (!option) continue
			const raw =
				option.kind === "none"
					? TEMPLATE_NONE_LABEL
					: truncate(
							`${option.template.name}${option.template.description ? `  ${option.template.description}` : ""}`,
							Math.max(1, contentW - 2),
						)
			const isSelected = i === picker.selected
			const dimFrom = option.kind === "template" ? option.template.name.length : raw.length
			const styled = isSelected ? fg("36", raw) : `${raw.slice(0, dimFrom)}${dim(raw.slice(dimFrom))}`
			lines.push(ansiRow(`${isSelected ? "> " : "  "}${styled}`, 2 + raw.length))
		}
		// Pad to a constant row count so filtering/navigation doesn't shift the
		// overlay underneath.
		for (let i = end; i < Math.min(options.length, start + PICKER_MAX_VISIBLE); i++) lines.push(ansiRow("", 0))

		const count = `${options.length - 1} template${options.length - 1 === 1 ? "" : "s"}`
		const hint = "↑/↓: choose  enter: select  tab: pick & next  esc: back"
		const hintText = truncate(`  ${dim(`${count}  ${hint}`)}`, contentW)
		lines.push(ansiRow(hintText, count.length + 2 + hint.length))
		return lines
	}

	private renderForm(contentW: number, ansiRow: (content: string, rawLen: number) => string): string[] {
		const { fields, selected, editing } = this.state
		const template = templateActive(this.state) ? selectedTemplate(this.state) : undefined
		const labelWidth = Math.max(...fields.map((f) => f.label.length), "Create workspace".length)

		const lines: string[] = []

		const actionIndex = fields.length
		for (const [i, field] of fields.entries()) {
			const isSelected = i === selected
			const isEditing = isSelected && editing
			const isChoice = field.id === "denyByDefault"
			const isTemplate = field.id === "template"
			// While a template is selected the server expands its values at
			// creation — the manual fields show the template's preset values
			// read-only (dimmed). Fields the template doesn't set keep their
			// placeholder (the workspace inherits the org default); the user's
			// own values stay in state and reappear when the template is cleared.
			const overridden = template !== undefined && field.id !== "template" && field.id !== "name"
			const templateValue = overridden && template ? templateFieldValue(field.id, template) : undefined
			const rawValue = isChoice ? denyByDefaultLabel(field.choice ?? "inherit") : field.value || field.placeholder
			const cellValue = templateValue ?? rawValue
			const cell = truncate(`${cellValue}${isEditing ? "█" : ""}`, Math.max(1, contentW - labelWidth - 3))
			const prefix = isSelected ? "> " : "  "
			// Dim placeholders and template-overridden values; set values are
			// shown plain.
			const showDim = isTemplate ? !field.value : Boolean(templateValue) || (!isChoice && !field.value && !isEditing)
			const raw = `${prefix}${dim(pad(field.label, labelWidth))}  ${showDim ? dim(cell) : cell}`
			const styled = isSelected ? fg("36", raw) : raw
			lines.push(ansiRow(styled, prefix.length + labelWidth + 2 + cell.length))
		}

		// Action row.
		if (selected === actionIndex) {
			const raw = `> ${pad("Create workspace", labelWidth)}`
			lines.push(ansiRow(fg("36", raw), raw.length))
		} else {
			const raw = `  ${fg("36", pad("Create workspace", labelWidth))}`
			lines.push(ansiRow(raw, "Create workspace".length + 2))
		}

		// Reserved error block (constant line count).
		const errorText = this.state.error
		const wrapped = errorText ? wrapTextWithAnsi(errorText, contentW).map((line) => truncate(line, contentW)) : []
		for (let i = 0; i < ERROR_LINES; i++) {
			const part = wrapped[i]
			if (part === undefined) {
				lines.push(ansiRow("", 0))
			} else if (i === ERROR_LINES - 1 && wrapped.length > ERROR_LINES) {
				const text = truncate(`${part}…`, contentW)
				lines.push(ansiRow(fg("31", text), text.length))
			} else {
				lines.push(ansiRow(fg("31", part), part.length))
			}
		}

		const hint = "↑/↓: field  enter: edit / choose / create  tab: next  esc: cancel"
		const hintText = truncate(`  ${dim(hint)}`, contentW)
		lines.push(ansiRow(hintText, hint.length + 2))
		return lines
	}

	invalidate(): void {}

	dispose(): void {}
}

export function openWorkspaceSetup(
	ctx: Pick<TeleportContext, "ui">,
	prefill: WorkspaceSetupPrefill,
	templates: WorkspaceTemplateSummary[] = [],
): Promise<WorkspaceSetupResult | undefined> {
	return ctx.ui.custom<WorkspaceSetupResult | undefined>(
		(tui, _theme, _kb, done) => new WorkspaceSetupPanel(prefill, templates, tui, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "80%" } },
	)
}
