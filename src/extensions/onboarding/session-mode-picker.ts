import type { Theme } from "@earendil-works/pi-coding-agent"
import { type Component, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"

export type SessionModePickerChoice = "ferment" | "default"
export type SessionModePickerResult = SessionModePickerChoice | "cancelled"
export type SessionModePickerEvent = "up" | "down" | "select" | "cancel"

export interface SessionModePickerOption {
	value: SessionModePickerChoice
	label: string
	description?: string
}

export interface SessionModePickerState {
	selectedIndex: number
}

export interface SessionModePickerReduceResult {
	state: SessionModePickerState
	result?: SessionModePickerResult
}

export const SESSION_MODE_PICKER_OPTIONS: SessionModePickerOption[] = [
	{
		value: "ferment",
		label: "Try a /ferment workflow",
		description:
			"The agent breaks the task into milestones, self-evaluates its output and delivers with minimal interruptions.",
	},
	{
		value: "default",
		label: "Skip",
	},
]

export function initialSessionModePickerState(): SessionModePickerState {
	return { selectedIndex: 0 }
}

export function reduceSessionModePicker(
	state: SessionModePickerState,
	event: SessionModePickerEvent,
): SessionModePickerReduceResult {
	if (event === "cancel") return { state, result: "cancelled" }
	if (event === "select") {
		const option = SESSION_MODE_PICKER_OPTIONS[state.selectedIndex]
		return { state, result: option.value }
	}
	if (event === "up") {
		return { state: { ...state, selectedIndex: Math.max(0, state.selectedIndex - 1) } }
	}
	if (event === "down") {
		return {
			state: { ...state, selectedIndex: Math.min(SESSION_MODE_PICKER_OPTIONS.length - 1, state.selectedIndex + 1) },
		}
	}
	return { state }
}

export function keyToSessionModePickerEvent(data: string): SessionModePickerEvent | undefined {
	if (matchesKey(data, Key.up)) return "up"
	if (matchesKey(data, Key.down)) return "down"
	if (matchesKey(data, Key.enter)) return "select"
	if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return "cancel"
	return undefined
}

export function renderSessionModePickerLines(state: SessionModePickerState, theme: Theme, width: number): string[] {
	const lines: string[] = []
	const innerWidth = Math.max(1, width - 2)
	const add = (line = "") => lines.push(truncateToWidth(line, width, ""))
	const indent = "  "

	add("")

	for (let i = 0; i < SESSION_MODE_PICKER_OPTIONS.length; i += 1) {
		const option = SESSION_MODE_PICKER_OPTIONS[i]
		const selected = i === state.selectedIndex
		const marker = selected ? "> " : "  "
		const label = selected ? theme.fg("accent", option.label) : theme.fg("dim", option.label)
		add(`${indent}${theme.fg(selected ? "accent" : "dim", marker)}${label}`)
		if (option.description) {
			const description = selected ? theme.fg("text", option.description) : theme.fg("dim", option.description)
			for (const wrapped of wrapTextWithAnsi(description, Math.max(1, innerWidth - 4))) {
				add(`${indent}  ${wrapped}`)
			}
		}
		if (i < SESSION_MODE_PICKER_OPTIONS.length - 1) add("")
	}

	add("")
	return lines
}

export interface SessionModePickerComponentOptions {
	initialState?: SessionModePickerState
	onStateChange?: (state: SessionModePickerState) => void
}

export class SessionModePickerComponent implements Component {
	private state: SessionModePickerState
	private readonly onStateChange?: (state: SessionModePickerState) => void

	constructor(
		private readonly theme: Theme,
		private readonly onDone: (result: SessionModePickerResult) => void,
		private readonly requestRender: () => void,
		options: SessionModePickerComponentOptions = {},
	) {
		this.state = options.initialState ?? initialSessionModePickerState()
		this.onStateChange = options.onStateChange
	}

	getState(): SessionModePickerState {
		return this.state
	}

	invalidate(): void {}

	render(width: number): string[] {
		return renderSessionModePickerLines(this.state, this.theme, width)
	}

	handleInput(data: string): void {
		const event = keyToSessionModePickerEvent(data)
		if (!event) return
		const next = reduceSessionModePicker(this.state, event)
		this.state = next.state
		this.onStateChange?.(this.state)
		if (next.result) {
			this.onDone(next.result)
			return
		}
		this.requestRender()
	}
}
