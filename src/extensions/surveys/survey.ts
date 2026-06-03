import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import {
	Container,
	Key,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui"
import { readSurveySeenAt, writeSurveySeenAt } from "../../config.js"
import { setTipWidgetLocation } from "../tips/index.js"

export const INITIAL_SURVEY = {
	id: "019e87cc-5033-0000-d9bd-5e6501640b6e",
	version: 1,
	question: {
		id: "34f7caf5-7631-42f1-b6ed-d2a42ddde1cd",
		text: "How did Kimchi do?",
		help: "Your feedback helps us improve.",
	},
	options: [
		{ id: "worked_great", label: "Went great" },
		{ id: "mostly_worked", label: "Mostly worked" },
		{ id: "didnt_work", label: "Didn't work" },
	],
} as const

export type InitialSurveyAnswerId = (typeof INITIAL_SURVEY.options)[number]["id"]
export type InitialSurveyTrigger = "third_coding_prompt" | "ferment_completed"
export type InitialSurveyDismissReason = "escape" | "ctrl_c"

type InitialSurveyResult =
	| { kind: "answered"; answerId: InitialSurveyAnswerId }
	| { kind: "dismissed"; reason: InitialSurveyDismissReason }

export interface ShowInitialSurveyOptions {
	configPath?: string
	now?: () => Date
	trigger: InitialSurveyTrigger
	onShown?: (trigger: InitialSurveyTrigger) => void
	onAnswered?: (answerId: InitialSurveyAnswerId, trigger: InitialSurveyTrigger) => void
	onDismissed?: (reason: InitialSurveyDismissReason, trigger: InitialSurveyTrigger) => void
}

const shownInProcess = new Set<string>()

export function _resetSurveyStateForTests(): void {
	shownInProcess.clear()
}

export function hasInitialSurveyBeenSeen(configPath?: string): boolean {
	return shownInProcess.has(INITIAL_SURVEY.id) || readSurveySeenAt(INITIAL_SURVEY.id, configPath) !== undefined
}

export function markInitialSurveySeen(options?: { configPath?: string; now?: () => Date }): string {
	const seenAt = (options?.now?.() ?? new Date()).toISOString()
	shownInProcess.add(INITIAL_SURVEY.id)
	writeSurveySeenAt(INITIAL_SURVEY.id, seenAt, options?.configPath)
	return seenAt
}

export async function showInitialSurvey(ctx: ExtensionContext, options: ShowInitialSurveyOptions): Promise<boolean> {
	if (!ctx.hasUI) return false
	if (hasInitialSurveyBeenSeen(options.configPath)) return false
	shownInProcess.add(INITIAL_SURVEY.id)
	let markedRendered = false
	const markRendered = () => {
		if (markedRendered) return
		markedRendered = true
		try {
			markInitialSurveySeen({ configPath: options.configPath, now: options.now })
		} catch (err) {
			ctx.ui.notify(`Could not save survey state: ${err instanceof Error ? err.message : String(err)}`, "warning")
		}
		options.onShown?.(options.trigger)
	}

	const restoreTips = setTipWidgetLocation("hidden")
	let result: InitialSurveyResult
	try {
		result = await ctx.ui.custom<InitialSurveyResult>((tui, theme, _kb, done) => {
			const component = new InitialSurveyComponent(theme, () => tui.requestRender(), done, markRendered)
			return component
		})
	} finally {
		restoreTips()
	}

	if (result.kind === "answered") {
		options.onAnswered?.(result.answerId, options.trigger)
	} else {
		options.onDismissed?.(result.reason, options.trigger)
	}

	return true
}

const SURVEY_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 18,
	maxPrimaryColumnWidth: 26,
}

export class InitialSurveyComponent extends Container {
	private readonly titleText: Text
	private readonly helpText: Text
	private readonly footerText: Text
	private readonly bottomRule: Text
	private readonly selectList: SelectList

	constructor(
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly done: (result: InitialSurveyResult) => void,
		private readonly onFirstRender?: () => void,
	) {
		super()
		this.titleText = new Text("", 0, 0)
		this.helpText = new Text("", 0, 0)
		this.footerText = new Text(this.formatFooter(), 0, 0)
		this.bottomRule = new Text("", 0, 0)
		this.selectList = new SelectList(
			this.items(),
			INITIAL_SURVEY.options.length,
			this.selectListTheme(),
			SURVEY_SELECT_LIST_LAYOUT,
		)
		this.selectList.onSelect = (item) => {
			this.done({ kind: "answered", answerId: item.value as InitialSurveyAnswerId })
		}

		this.addChild(this.titleText)
		this.addChild(this.helpText)
		this.addChild(new Spacer(1))
		this.addChild(this.selectList)
		this.addChild(new Spacer(1))
		this.addChild(this.footerText)
		this.addChild(this.bottomRule)
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done({ kind: "dismissed", reason: "escape" })
			return
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this.done({ kind: "dismissed", reason: "ctrl_c" })
			return
		}
		this.selectList.handleInput(data)
		this.requestRender()
	}

	render(width: number): string[] {
		this.onFirstRender?.()
		const safeWidth = Math.max(24, width)
		const title: string = INITIAL_SURVEY.question.text
		const titlePrefix = "─── "
		const titleText = `${titlePrefix}${title} `
		const ruleWidth = Math.max(3, safeWidth - titleText.length)
		this.titleText.setText(this.theme.fg("accent", `${titleText}${"─".repeat(ruleWidth)}`))
		const help: string | undefined = INITIAL_SURVEY.question.help
		this.helpText.setText(help && help !== title ? this.theme.fg("text", truncateToWidth(help, safeWidth)) : "")
		this.bottomRule.setText(this.theme.fg("accent", "─".repeat(safeWidth)))
		return super.render(width)
	}

	private items(): SelectItem[] {
		return INITIAL_SURVEY.options.map((option) => {
			const [label, description] = splitOptionLabel(option.label)
			return {
				value: option.id,
				label,
				description: description ? `- ${description}` : undefined,
			}
		})
	}

	private selectListTheme() {
		return {
			selectedPrefix: (text: string) => this.theme.fg("accent", text),
			selectedText: (text: string) => this.theme.fg("text", text),
			description: (text: string) => this.theme.fg("dim", text),
			scrollInfo: (text: string) => this.theme.fg("muted", text),
			noMatch: (text: string) => this.theme.fg("muted", text),
		}
	}

	private formatFooter(): string {
		const dim = (text: string) => this.theme.fg("dim", text)
		const muted = (text: string) => this.theme.fg("muted", text)
		return `${dim("[↑]")}${dim("[↓]")} ${muted("move")}  ${dim("·")}  ${dim("[↵]")} ${muted("select")}`
	}
}

function splitOptionLabel(label: string): [string, string | undefined] {
	const idx = label.indexOf(" - ")
	if (idx === -1) return [label, undefined]
	return [label.slice(0, idx), label.slice(idx + 3)]
}
