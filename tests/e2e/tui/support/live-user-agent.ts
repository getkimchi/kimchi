export type SupervisorAction = "wait" | "submit" | "keys" | "complete" | "fail"
export type DigitKey = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
export type LiveKey = "enter" | "down" | "up" | "left" | "right" | "tab" | "space" | "escape" | "ctrl_c" | DigitKey

export interface SupervisorDecision {
	action: SupervisorAction
	reason: string
	answer?: string
	keys?: LiveKey[]
	confidence?: number
	blocked_by?: string
	ui_state?: string
}

type QuestionnaireTabStatus = "unanswered" | "answered" | "submit"

interface QuestionnaireTab {
	label: string
	status: QuestionnaireTabStatus
}

export class UserSimulatorDecisionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "UserSimulatorDecisionError"
	}
}

const ALLOWED_ACTIONS: readonly SupervisorAction[] = ["wait", "submit", "keys", "complete", "fail"]
const ALLOWED_KEYS: readonly LiveKey[] = [
	"enter",
	"down",
	"up",
	"left",
	"right",
	"tab",
	"space",
	"escape",
	"ctrl_c",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
]

export function normalizeSupervisorDecision(raw: unknown): SupervisorDecision {
	const decision = asDecisionRecord(raw)
	const action = decision.action
	if (!ALLOWED_ACTIONS.includes(action as SupervisorAction)) {
		throw new UserSimulatorDecisionError(`Supervisor returned invalid action: ${String(action)}`)
	}
	if (action === "submit") {
		const answer = String(decision.answer ?? "")
		const reason = String(decision.reason ?? "")
		if (!answer.trim())
			return { action: "keys", keys: ["enter"], reason: `${reason} (normalized empty submit to Enter)` }
		if (/^[1-9]$/.test(answer.trim()))
			return {
				action: "keys",
				keys: [answer.trim() as DigitKey],
				reason: `${reason} (normalized numeric submit to key press)`,
			}
		return { action, answer, reason, ...decisionMetadata(decision) }
	}
	if (action === "keys") {
		if (!Array.isArray(decision.keys) || decision.keys.length === 0) {
			throw new UserSimulatorDecisionError("Supervisor returned keys action without keys")
		}
		const invalid = decision.keys.filter((key) => !ALLOWED_KEYS.includes(String(key) as LiveKey))
		if (invalid.length > 0) {
			const typedText = printableTextFromKeys(decision.keys)
			if (typedText) {
				return {
					action: "submit",
					answer: typedText,
					reason: `${String(decision.reason ?? "")} (normalized printable keys to submit)`,
					...decisionMetadata(decision),
				}
			}
		}
		if (invalid.length > 0) {
			throw new UserSimulatorDecisionError(`Supervisor returned invalid keys: ${invalid.map(String).join(", ")}`)
		}
		return {
			action,
			keys: decision.keys.map((key) => String(key) as LiveKey),
			reason: String(decision.reason ?? ""),
			...decisionMetadata(decision),
		}
	}
	return { action, reason: String(decision.reason ?? ""), ...decisionMetadata(decision) }
}

export function questionnaireNavigationDecision(screen: string): SupervisorDecision | undefined {
	if (!/Tab\/←→ navigate/i.test(screen)) return undefined
	const tabs = parseQuestionnaireTabs(screen)
	if (tabs.length === 0) return undefined

	const targetIndex = firstUnansweredTabIndex(screen, tabs)
	if (targetIndex < 0) {
		if (/Ready to submit/i.test(screen) && !/Unanswered:/i.test(screen)) {
			const submitIndex = tabs.findIndex((tab) => tab.status === "submit")
			if (submitIndex >= 0) {
				return moveBetweenTabs(tabs.length - 1, submitIndex, tabs.length, "Submit completed questionnaire.")
			}
		}
		return undefined
	}

	const summaryScreen = /Ready to submit/i.test(screen) || /Unanswered:/i.test(screen)
	const answeredAfterTarget = tabs.slice(targetIndex + 1).some((tab) => tab.status === "answered")
	if (!summaryScreen && !answeredAfterTarget) return undefined

	const currentIndex = inferQuestionnaireTabIndex(screen, tabs, targetIndex)
	if (currentIndex === targetIndex) return undefined
	return moveBetweenTabs(
		currentIndex,
		targetIndex,
		tabs.length,
		`Open unanswered questionnaire tab "${tabs[targetIndex]?.label ?? "unknown"}".`,
	)
}

function parseQuestionnaireTabs(screen: string): QuestionnaireTab[] {
	const line = screen.split("\n").find((candidate) => candidate.includes("←") && candidate.includes("→"))
	if (!line) return []
	const tabs: QuestionnaireTab[] = []
	const pattern = /([□■✓])\s*([^□■✓←→]+?)(?=\s{2,}|→|$)/g
	for (const match of line.matchAll(pattern)) {
		const marker = match[1]
		const label = match[2]?.trim()
		if (!label) continue
		tabs.push({
			label,
			status: marker === "□" ? "unanswered" : marker === "✓" ? "submit" : "answered",
		})
	}
	return tabs
}

function firstUnansweredTabIndex(screen: string, tabs: QuestionnaireTab[]): number {
	const explicit = screen.match(/Unanswered:\s*([^\n]+)/i)?.[1]
	if (explicit) {
		const labels = explicit
			.split(/,|\band\b/i)
			.map((label) => label.trim().toLowerCase())
			.filter(Boolean)
		const explicitIndex = tabs.findIndex((tab) => labels.includes(tab.label.toLowerCase()))
		if (explicitIndex >= 0) return explicitIndex
	}
	return tabs.findIndex((tab) => tab.status === "unanswered")
}

function inferQuestionnaireTabIndex(screen: string, tabs: QuestionnaireTab[], targetIndex: number): number {
	const submitIndex = tabs.findIndex((tab) => tab.status === "submit")
	if (/Ready to submit/i.test(screen) && submitIndex >= 0) return submitIndex
	const answeredIndexes = tabs
		.map((tab, index) => ({ tab, index }))
		.filter(({ tab, index }) => tab.status === "answered" && index > targetIndex)
		.map(({ index }) => index)
	return answeredIndexes.at(-1) ?? Math.max(0, Math.min(tabs.length - 1, targetIndex))
}

function moveBetweenTabs(
	fromIndex: number,
	toIndex: number,
	tabCount: number,
	reason: string,
): SupervisorDecision | undefined {
	const steps = (toIndex - fromIndex + tabCount) % tabCount
	const keys: LiveKey[] = [...Array.from({ length: steps }, () => "tab" as const), "enter"]
	return { action: "keys", keys, reason }
}

function printableTextFromKeys(keys: unknown[]): string | undefined {
	const text: string[] = []
	for (const key of keys) {
		const value = String(key)
		if (value === "enter") break
		if (value.length !== 1 || !/^[ -~]$/.test(value)) return undefined
		text.push(value)
	}
	const joined = text.join("").trim()
	return joined.length > 0 ? joined : undefined
}

function decisionMetadata(
	decision: Record<string, unknown>,
): Pick<SupervisorDecision, "confidence" | "blocked_by" | "ui_state"> {
	const metadata: Pick<SupervisorDecision, "confidence" | "blocked_by" | "ui_state"> = {}
	if (typeof decision.confidence === "number" && Number.isFinite(decision.confidence)) {
		metadata.confidence = Math.max(0, Math.min(1, decision.confidence))
	}
	if (typeof decision.blocked_by === "string" && decision.blocked_by.trim()) {
		metadata.blocked_by = decision.blocked_by
	}
	if (typeof decision.ui_state === "string" && decision.ui_state.trim()) {
		metadata.ui_state = decision.ui_state
	}
	return metadata
}

function asDecisionRecord(raw: unknown): Record<string, unknown> & { action: SupervisorAction } {
	if (!raw || typeof raw !== "object") {
		throw new UserSimulatorDecisionError("Supervisor returned a non-object decision")
	}
	const record = raw as Record<string, unknown>
	return { ...record, action: record.action as SupervisorAction }
}
