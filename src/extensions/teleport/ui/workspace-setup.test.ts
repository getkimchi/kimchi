import { describe, expect, it, vi } from "vitest"
import type { WorkspaceTemplateSummary } from "../../../sandbox/cloud/types.js"
import {
	assembleWorkspaceSpec,
	denyByDefaultLabel,
	filteredTemplateOptions,
	initialWorkspaceSetupState,
	keyToWorkspaceSetupEvent,
	openWorkspaceSetup,
	reduceWorkspaceSetup,
	splitListField,
	WorkspaceSetupPanel,
	type WorkspaceSetupPrefill,
	type WorkspaceSetupState,
} from "./workspace-setup.js"

type FormState = WorkspaceSetupState

function prefill(overrides?: Partial<WorkspaceSetupPrefill>): WorkspaceSetupPrefill {
	return {
		name: "proj",
		file: {
			resources: { cpu: " 500m ", memory: "1Gi", pvcSize: "10Gi" },
			dependencies: ["jq", "node@22"],
			egressPolicy: { denyByDefault: true, allowed: ["github.com:443"] },
		},
		...overrides,
	}
}

function stateFrom(p: WorkspaceSetupPrefill = prefill()): FormState {
	// No templates → no Template field, plain manual form.
	return initialWorkspaceSetupState(p)
}

/** Reduce inside the form: the single-page dialog never leaves it. */
function reduceForm(state: FormState, event: Parameters<typeof reduceWorkspaceSetup>[1]): FormState {
	return reduceWorkspaceSetup(state, event).state
}

describe("initialWorkspaceSetupState", () => {
	it("prefills name and kimchi_workspace.yaml values", () => {
		const state = stateFrom()
		expect(state.fields.map((f) => f.id)).toEqual([
			"name",
			"cpu",
			"memory",
			"pvcSize",
			"dependencies",
			"denyByDefault",
			"allowed",
			"denied",
		])
		expect(state.fields[0].value).toBe("proj")
		expect(state.fields[1].value).toBe(" 500m ") // raw value; trimmed only on assemble
		expect(state.fields[4].value).toBe("jq, node@22")
		expect(state.fields[5].choice).toBe(true)
		expect(state.fields[6].value).toBe("github.com:443")
		expect(state.selected).toBe(0)
		expect(state.editing).toBe(false)
	})

	it("leaves fields empty without a file (org defaults)", () => {
		const state = stateFrom({ name: "proj" })
		expect(state.fields.slice(1, 5).every((f) => f.value === "")).toBe(true)
		expect(state.fields[5].choice).toBe("inherit")
	})
})

describe("keyToWorkspaceSetupEvent", () => {
	it("maps navigation and editing keys", () => {
		expect(keyToWorkspaceSetupEvent("\x1b[A")).toEqual({ kind: "up" })
		expect(keyToWorkspaceSetupEvent("\x1b[B")).toEqual({ kind: "down" })
		expect(keyToWorkspaceSetupEvent("\t")).toEqual({ kind: "tab" })
		expect(keyToWorkspaceSetupEvent("\r")).toEqual({ kind: "enter" })
		expect(keyToWorkspaceSetupEvent("\x1b")).toEqual({ kind: "cancel" })
		expect(keyToWorkspaceSetupEvent("\x7f")).toEqual({ kind: "backspace" })
		expect(keyToWorkspaceSetupEvent("5")).toEqual({ kind: "char", char: "5" })
	})

	it("strips bracketed-paste markers and rejects control characters", () => {
		expect(keyToWorkspaceSetupEvent("\x1b[200~1.5Gi\x1b[201~")).toEqual({ kind: "char", char: "1.5Gi" })
		expect(keyToWorkspaceSetupEvent("\x01")).toBeUndefined()
		expect(keyToWorkspaceSetupEvent("")).toBeUndefined()
	})
})

describe("reduceWorkspaceSetup — navigation", () => {
	it("moves between fields and clamps at both ends", () => {
		let state = reduceForm(stateFrom(), { kind: "up" })
		expect(state.selected).toBe(0)
		for (let i = 0; i < 20; i++) state = reduceForm(state, { kind: "down" })
		// Last selectable index = action row (= fields.length).
		expect(state.selected).toBe(state.fields.length)
		state = reduceForm(state, { kind: "tab" })
		expect(state.selected).toBe(state.fields.length)
	})

	it("tab and enter commit an active edit and move down", () => {
		let state = reduceForm(stateFrom(), { kind: "enter" }) // start editing name
		expect(state.editing).toBe(true)
		state = reduceForm(state, { kind: "char", char: "X" })
		state = reduceForm(state, { kind: "enter" }) // commit + move
		expect(state.editing).toBe(false)
		expect(state.fields[0].value).toBe("projX")
		expect(state.selected).toBe(1)
	})
})

describe("reduceWorkspaceSetup — text editing", () => {
	it("appends characters and deletes with backspace", () => {
		let state = reduceForm(stateFrom(), { kind: "enter" })
		for (const ch of "200m") state = reduceForm(state, { kind: "char", char: ch })
		state = reduceForm(state, { kind: "backspace" })
		// Editing the name field; chars land there, backspace drops one.
		expect(state.fields[0].value).toBe("proj200")
	})

	it("ignores char/backspace when not editing", () => {
		const state = stateFrom()
		expect(reduceForm(state, { kind: "char", char: "x" })).toEqual(state)
		expect(reduceForm(state, { kind: "backspace" })).toEqual(state)
	})
})

describe("reduceWorkspaceSetup — egress mode cycling", () => {
	it("cycles inherit → deny → allow → inherit on enter without editing", () => {
		let state = reduceForm(stateFrom({ name: "p", file: undefined }), { kind: "down" })
		state = reduceForm(state, { kind: "down" })
		state = reduceForm(state, { kind: "down" })
		state = reduceForm(state, { kind: "down" })
		state = reduceForm(state, { kind: "down" }) // → egress-mode field (index 5)
		const choiceField = (s: FormState) => s.fields.find((f) => f.id === "denyByDefault")?.choice
		state = reduceForm(state, { kind: "enter" })
		expect(choiceField(state)).toBe(true)
		expect(state.editing).toBe(false)
		state = reduceForm(state, { kind: "enter" })
		expect(choiceField(state)).toBe(false)
		state = reduceForm(state, { kind: "enter" })
		expect(choiceField(state)).toBe("inherit")
	})

	it("renders all three postures", () => {
		expect(denyByDefaultLabel("inherit")).toBe("(server default)")
		expect(denyByDefaultLabel(true)).toBe("deny by default")
		expect(denyByDefaultLabel(false)).toBe("allow by default")
	})
})

describe("reduceWorkspaceSetup — cancel", () => {
	it("esc while editing leaves the field; esc again cancels", () => {
		const state = reduceForm(stateFrom(), { kind: "enter" }) // start editing
		const leftField = reduceWorkspaceSetup(state, { kind: "cancel" })
		expect(leftField.result).toBeUndefined()
		expect(leftField.state.editing).toBe(false)
		const cancelled = reduceWorkspaceSetup(leftField.state, { kind: "cancel" })
		expect(cancelled.result).toEqual({ action: "cancel" })
	})
})

describe("assembleWorkspaceSpec", () => {
	it("builds a full spec from prefill values (trimming quantities)", () => {
		const { name, spec, error } = assembleWorkspaceSpec(stateFrom())
		expect(error).toBeUndefined()
		expect(name).toBe("proj")
		expect(spec).toEqual({
			resources: { cpu: "500m", memory: "1Gi", pvcSize: "10Gi" },
			dependencies: ["jq", "node@22"],
			egressPolicy: { denyByDefault: true, allowed: ["github.com:443"] },
		})
	})

	it("omits empty fields (org defaults) and undefined name", () => {
		const state = stateFrom({ name: "" })
		const { name, spec } = assembleWorkspaceSpec(state)
		expect(name).toBeUndefined()
		expect(spec).toBeUndefined()
	})

	it("serializes an explicit denyByDefault: false", () => {
		const state = stateFrom({ name: "p" })
		const cycled = state.fields.map((f) => (f.id === "denyByDefault" ? { ...f, choice: false as const } : f))
		const { spec } = assembleWorkspaceSpec({ ...state, fields: cycled })
		expect(spec).toEqual({ egressPolicy: { denyByDefault: false } })
	})

	it("reports validation violations as an error, not a throw", () => {
		const fields = stateFrom({ name: "p" }).fields.map((f) => (f.id === "cpu" ? { ...f, value: "1Gii" } : f))
		const { spec, error } = assembleWorkspaceSpec({ ...stateFrom({ name: "p" }), fields })
		expect(spec).toBeUndefined()
		expect(error).toContain("1Gii")
	})
})

describe("splitListField", () => {
	it("splits on commas, trims, and drops empties", () => {
		expect(splitListField("jq, node@22 ,,c")).toEqual(["jq", "node@22", "c"])
		expect(splitListField("")).toEqual([])
		expect(splitListField("  ")).toEqual([])
	})
})

describe("reduceWorkspaceSetup — submit", () => {
	it("on the action row returns the assembled spec and name", () => {
		let state = stateFrom()
		state = { ...state, selected: state.fields.length }
		const { state: next, result } = reduceWorkspaceSetup(state, { kind: "enter" })
		expect(next.error).toBeUndefined()
		expect(result).toEqual({
			action: "create",
			name: "proj",
			spec: {
				resources: { cpu: "500m", memory: "1Gi", pvcSize: "10Gi" },
				dependencies: ["jq", "node@22"],
				egressPolicy: { denyByDefault: true, allowed: ["github.com:443"] },
			},
		})
	})

	it("keeps the dialog open with the violation text on invalid input", () => {
		const fields = stateFrom().fields.map((f) => (f.id === "memory" ? { ...f, value: "banana" } : f))
		const state = { ...stateFrom(), fields, selected: fields.length }
		const { state: next, result } = reduceWorkspaceSetup(state, { kind: "enter" })
		expect(result).toBeUndefined()
		expect(next.error).toContain("banana")
	})

	it("returns no name when cleared and no spec when everything is empty", () => {
		const fields = stateFrom().fields.map((f) => ({ ...f, value: "", choice: "inherit" as const }))
		const state = { ...stateFrom(), fields, selected: fields.length }
		const { result } = reduceWorkspaceSetup(state, { kind: "enter" })
		expect(result).toEqual({ action: "create", name: undefined, spec: undefined })
	})
})

describe("WorkspaceSetupPanel", () => {
	const FIELD_COUNT = 8

	function makePanel(p: WorkspaceSetupPrefill = prefill()) {
		const tui = { requestRender: vi.fn() }
		const done = vi.fn()
		const panel = new WorkspaceSetupPanel(p, [], tui, done)
		return { panel, tui, done }
	}

	const DOWN = "\x1b[B"

	it("renders a constant line count with and without an error", () => {
		const width = 80
		const clean = makePanel().panel.render(width)

		// Type an invalid CPU through the real input path, then submit.
		const driven = makePanel()
		driven.panel.handleInput(DOWN) // → CPU
		driven.panel.handleInput("\r") // start editing
		driven.panel.handleInput("1Gii")
		driven.panel.handleInput("\r") // commit + move down
		for (let i = 0; i < FIELD_COUNT - 1; i++) driven.panel.handleInput(DOWN)
		driven.panel.handleInput("\r") // submit from action row
		expect(driven.done).not.toHaveBeenCalled() // dialog stayed open

		const withError = driven.panel.render(width)
		expect(withError.length).toBe(clean.length)
		expect(withError.join("\n")).toContain("1Gii")
	})

	it("renders degenerate widths without crashing (≥1 clamps)", () => {
		const { panel } = makePanel()
		expect(() => panel.render(4)).not.toThrow()
		expect(panel.render(4).length).toBeGreaterThan(0)
	})

	it("marks the selected row and moves the marker with input", () => {
		const { panel } = makePanel()
		const first = panel.render(80)
		expect(first.some((l) => l.includes("> "))).toBe(true)
		panel.handleInput(DOWN)
		expect(panel.render(80)).not.toEqual(first)
	})

	it("create submits through done; escape cancels", () => {
		const { panel, done } = makePanel()
		for (let i = 0; i < FIELD_COUNT; i++) panel.handleInput(DOWN)
		panel.handleInput("\r")
		expect(done).toHaveBeenCalledOnce()
		expect(done.mock.calls[0][0]).toMatchObject({ action: "create", name: "proj" })

		const { panel: p2, done: done2 } = makePanel()
		p2.handleInput("\x1b")
		expect(done2).toHaveBeenCalledWith({ action: "cancel" })
	})

	it("openWorkspaceSetup resolves through ctx.ui.custom", async () => {
		const custom = vi.fn(() => Promise.resolve({ action: "create" as const, name: "ws" }))
		const result = await openWorkspaceSetup({ ui: { custom } as never }, { name: "ws" })
		expect(result).toEqual({ action: "create", name: "ws" })
		expect(custom).toHaveBeenCalledOnce()
	})
})

describe("template field (searchable picker)", () => {
	const TEMPLATES: WorkspaceTemplateSummary[] = [
		{
			id: "t1",
			name: "team-stack",
			description: "Team defaults",
			spec: {
				resources: { cpu: "1", memory: "2Gi" },
				dependencies: ["jq"],
				egressPolicy: { denyByDefault: true },
			},
		},
		{ id: "t2", name: "minimal", description: "" },
	]

	function formFrom(p: WorkspaceSetupPrefill = prefill()): FormState {
		return initialWorkspaceSetupState(p, TEMPLATES)
	}

	/** State with team-stack selected via the picker. */
	function templateSelected(): FormState {
		let state = reduceWorkspaceSetup(formFrom(), { kind: "enter" }).state // picker
		state = reduceWorkspaceSetup(state, { kind: "down" }).state // → team-stack
		return reduceWorkspaceSetup(state, { kind: "enter" }).state // apply
	}

	const templateValue = (s: WorkspaceSetupState): string => s.fields.find((f) => f.id === "template")?.value ?? ""

	it("leads the form with the Template field when templates exist", () => {
		const state = formFrom()
		expect(state.fields.map((f) => f.id)[0]).toBe("template")
		expect(templateValue(state)).toBe("")
		expect(state.fields.map((f) => f.id)).toContain("cpu")
	})

	it("omits the Template field when the catalog is empty", () => {
		const state = stateFrom()
		expect(state.fields.map((f) => f.id)).not.toContain("template")
	})

	it("enter on the Template field opens the picker, esc closes it unchanged", () => {
		let state = formFrom()
		state = reduceWorkspaceSetup(state, { kind: "enter" }).state // open picker
		expect(state.picker).toEqual({ query: "", selected: 0 })
		state = reduceWorkspaceSetup(state, { kind: "cancel" }).state
		expect(state.picker).toBeUndefined()
		expect(templateValue(state)).toBe("")
	})

	it("typing filters the template list", () => {
		const state = formFrom()
		const opened = reduceWorkspaceSetup(state, { kind: "enter" }).state
		let filtered = opened
		for (const ch of "tea") filtered = reduceWorkspaceSetup(filtered, { kind: "char", char: ch }).state
		expect(filtered.picker?.query).toBe("tea")
		// Only the none-row + team-stack match "tea".
		expect(filteredTemplateOptions(TEMPLATES, "tea")).toHaveLength(2)
		expect(filteredTemplateOptions(TEMPLATES, "zzz")).toHaveLength(1)
		// Description matches too.
		expect(filteredTemplateOptions(TEMPLATES, "defaults")[1]).toEqual({
			kind: "template",
			template: TEMPLATES[0],
		})
	})

	it("enter applies the highlighted template; tab applies and moves on", () => {
		let state = reduceWorkspaceSetup(formFrom(), { kind: "enter" }).state // picker
		state = reduceWorkspaceSetup(state, { kind: "down" }).state // → team-stack
		state = reduceWorkspaceSetup(state, { kind: "enter" }).state // apply
		expect(state.picker).toBeUndefined()
		expect(templateValue(state)).toBe("team-stack")
		expect(state.selected).toBe(0) // stays on the Template field

		// Re-open, pick via tab → applies and moves to the next field.
		state = reduceWorkspaceSetup(state, { kind: "enter" }).state
		state = reduceWorkspaceSetup(state, { kind: "tab" }).state // none + move on
		expect(templateValue(state)).toBe("")
		expect(state.selected).toBe(1) // → Name
	})

	it("picking none clears the template and restores manual configuration", () => {
		let state = reduceWorkspaceSetup(formFrom(), { kind: "enter" }).state
		state = reduceWorkspaceSetup(state, { kind: "down" }).state
		state = reduceWorkspaceSetup(state, { kind: "enter" }).state // team-stack
		state = reduceWorkspaceSetup(state, { kind: "enter" }).state // reopen
		state = reduceWorkspaceSetup(state, { kind: "enter" }).state // none is highlighted at 0
		expect(templateValue(state)).toBe("")
	})

	it("submitting with a template returns templateName and no spec — leftover invalid fields are ignored", () => {
		const base = formFrom()
		const fields = base.fields.map((f) => (f.id === "cpu" ? { ...f, value: "1Gii" } : f))
		let state: WorkspaceSetupState = { ...base, fields }
		state = reduceWorkspaceSetup(state, { kind: "enter" }).state // picker
		state = reduceWorkspaceSetup(state, { kind: "down" }).state
		state = reduceWorkspaceSetup(state, { kind: "enter" }).state // team-stack
		// Submit from the action row (the enter-apply left us on the Template
		// field; a plain enter there would just re-open the picker).
		const submitted = reduceWorkspaceSetup({ ...state, selected: state.fields.length }, { kind: "enter" })
		expect(submitted.result).toEqual({ action: "create", name: "proj", templateName: "team-stack" })
	})

	it("submitting without a template keeps validating the manual fields", () => {
		const base = formFrom()
		const fields = base.fields.map((f) => (f.id === "cpu" ? { ...f, value: "1Gii" } : f))
		const submitted = reduceWorkspaceSetup({ ...base, fields, selected: base.fields.length }, { kind: "enter" })
		expect(submitted.result).toBeUndefined()
	})

	it("esc in the form cancels the dialog (single page)", () => {
		expect(reduceWorkspaceSetup(formFrom(), { kind: "cancel" }).result).toEqual({ action: "cancel" })
	})

	it("renders the Template field, template rows and the filter line", () => {
		const panel = new WorkspaceSetupPanel(prefill(), TEMPLATES, { requestRender: vi.fn() }, vi.fn())
		const text = panel.render(90).join("\n")
		// Closed form: the Template field shows the none placeholder; template
		// names appear only in the open picker.
		expect(text).toContain("(none — manual configuration)")
		expect(text).not.toContain("team-stack")
		expect(text).not.toContain("Filter:")

		panel.handleInput("\r") // open picker
		const pickerText = panel.render(90).join("\n")
		expect(pickerText).toContain("Filter:")
		expect(pickerText).toContain("team-stack")
		expect(pickerText).toContain("Team defaults")
		expect(pickerText).toContain("2 templates")
	})

	it("a selected template shows its preset values read-only in the fields", () => {
		const panel = new WorkspaceSetupPanel(prefill(), TEMPLATES, { requestRender: vi.fn() }, vi.fn())
		panel.handleInput("\r") // picker
		panel.handleInput("\x1b[B") // → team-stack
		panel.handleInput("\r") // apply
		const text = panel.render(90).join("\n")
		expect(text).toContain("team-stack")
		// The template's preset values, read-only in the manual fields.
		expect(text).toContain("1") // cpu
		expect(text).toContain("2Gi") // memory
		expect(text).toContain("jq") // dependencies
		expect(text).toContain("deny by default") // egress mode
		// The user's own values are hidden while the template governs.
		expect(text).not.toContain("500m")
		expect(text).not.toContain("node@22")
	})

	it("a selected template prevents changing the overridden fields", () => {
		const state = templateSelected()
		const cpuIndex = state.fields.findIndex((f) => f.id === "cpu")
		// enter on cpu must NOT start editing while a template governs.
		const cpuResult = reduceWorkspaceSetup({ ...state, selected: cpuIndex }, { kind: "enter" })
		expect(cpuResult.state.editing).toBe(false)
		expect(cpuResult.result).toBeUndefined()
		// Typing goes nowhere (not editing) — the user's value is untouched
		// (it is only hidden in the render while the template governs).
		const typed = reduceWorkspaceSetup(cpuResult.state, { kind: "char", char: "9" }).state
		expect(typed.fields.find((f) => f.id === "cpu")?.value).toBe(" 500m ")
		// denyByDefault must not cycle while a template governs.
		const denyIndex = state.fields.findIndex((f) => f.id === "denyByDefault")
		const denyBefore = state.fields.find((f) => f.id === "denyByDefault")?.choice
		const denied = reduceWorkspaceSetup({ ...state, selected: denyIndex }, { kind: "enter" }).state
		expect(denied.fields.find((f) => f.id === "denyByDefault")?.choice).toBe(denyBefore)
		// Name stays editable.
		const nameIndex = state.fields.findIndex((f) => f.id === "name")
		const named = reduceWorkspaceSetup({ ...state, selected: nameIndex }, { kind: "enter" }).state
		expect(named.editing).toBe(true)
	})

	it("clearing the template restores the user's own manual values", () => {
		const panel = new WorkspaceSetupPanel(prefill(), TEMPLATES, { requestRender: vi.fn() }, vi.fn())
		panel.handleInput("\r") // picker
		panel.handleInput("\x1b[B") // → team-stack
		panel.handleInput("\r") // apply — template governs
		expect(panel.render(90).join("\n")).not.toContain("500m")
		panel.handleInput("\r") // reopen picker (on Template field)
		panel.handleInput("\r") // pick none (highlighted at 0)
		const text = panel.render(90).join("\n")
		expect(text).toContain("500m")
		expect(text).toContain("node@22")
	})

	it("a template without spec shows placeholders and stays read-only", () => {
		const bare: WorkspaceTemplateSummary[] = [{ id: "t2", name: "minimal", description: "" }]
		let state: WorkspaceSetupState = initialWorkspaceSetupState(prefill(), bare)
		state = reduceWorkspaceSetup(state, { kind: "enter" }).state // picker
		state = reduceWorkspaceSetup(state, { kind: "down" }).state // → minimal
		state = reduceWorkspaceSetup(state, { kind: "enter" }).state // apply
		expect(state.fields.find((f) => f.id === "template")?.value).toBe("minimal")
		// No spec → placeholders (org defaults), but still read-only.
		const cpuIndex = state.fields.findIndex((f) => f.id === "cpu")
		const cpu = reduceWorkspaceSetup({ ...state, selected: cpuIndex }, { kind: "enter" })
		expect(cpu.state.editing).toBe(false)
	})
})
