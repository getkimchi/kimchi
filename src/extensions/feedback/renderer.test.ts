import type { Theme } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import type { FeedbackSummaryDetails, ModelSwitchSummaryDetails } from "./renderer.js"
import { feedbackSummaryRenderer } from "./renderer.js"

function makeTheme(): Theme {
	return {
		fg: (_color: string, s: string) => s,
		bg: (_color: string, s: string) => s,
		bold: (s: string) => s,
		getFgAnsi: (_color: string) => "",
	} as unknown as Theme
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: test-only helper
const ANSI_RE = /\x1b\[[0-9;]*m/g
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "")
}

type RendererEntry = Parameters<typeof feedbackSummaryRenderer>[0]
type RendererOptions = Parameters<typeof feedbackSummaryRenderer>[1]

/** Custom entries carry their payload on `data`, not `details`. */
function makeEntry(data: FeedbackSummaryDetails | ModelSwitchSummaryDetails | undefined): RendererEntry {
	return { type: "custom", customType: "feedback-summary", data } as unknown as RendererEntry
}

function makeOptions(): RendererOptions {
	return {} as unknown as RendererOptions
}

describe("feedbackSummaryRenderer", () => {
	it("renders the rating and reason for positive sentiment", () => {
		const details: FeedbackSummaryDetails = {
			sentiment: "positive",
			reason: "Solved my task",
		}
		const container = feedbackSummaryRenderer(makeEntry(details), makeOptions(), makeTheme())
		expect(container).toBeDefined()
		const text = container?.render(80).map(stripAnsi).join("\n") ?? ""
		expect(text).toContain("Thanks, feedback received!")
		expect(text).toContain("Your rating: Good")
		expect(text).toContain("Reason: Solved my task")
		expect(text.indexOf("Thanks, feedback received!")).toBeLessThan(text.indexOf("Your rating: Good"))
	})

	it("renders the rating and reason for negative sentiment", () => {
		const details: FeedbackSummaryDetails = {
			sentiment: "negative",
			reason: "Didn't solve the task",
		}
		const container = feedbackSummaryRenderer(makeEntry(details), makeOptions(), makeTheme())
		const text = container?.render(80).map(stripAnsi).join("\n") ?? ""
		expect(text).toContain("Thanks, feedback received!")
		expect(text).toContain("Your rating: Bad")
		expect(text).toContain("Reason: Didn't solve the task")
		expect(text.indexOf("Thanks, feedback received!")).toBeLessThan(text.indexOf("Your rating: Bad"))
	})

	it("renders rating above feedback", () => {
		const details: FeedbackSummaryDetails = {
			sentiment: "positive",
			reason: "Fast response",
		}
		const container = feedbackSummaryRenderer(makeEntry(details), makeOptions(), makeTheme())
		const text = container?.render(80).map(stripAnsi).join("\n") ?? ""
		expect(text).toContain("Thanks, feedback received!")
		expect(text).toContain("Your rating: Good")
		expect(text).toContain("Reason: Fast response")
		expect(text.indexOf("Thanks, feedback received!")).toBeLessThan(text.indexOf("Your rating: Good"))
		expect(text.indexOf("Your rating: Good")).toBeLessThan(text.indexOf("Reason: Fast response"))
		expect(text).not.toContain("Details:")
		expect(text).not.toContain("Feedback:")
		expect(text).not.toContain("Rating: good")
		expect(text).not.toContain("Rating: bad")
	})

	it("omits the reason line when the user submitted no reason", () => {
		const details: FeedbackSummaryDetails = {
			sentiment: "positive",
			reason: "",
		}
		const container = feedbackSummaryRenderer(makeEntry(details), makeOptions(), makeTheme())
		const text = container?.render(80).map(stripAnsi).join("\n") ?? ""
		expect(text).toContain("Thanks, feedback received!")
		expect(text).toContain("Your rating: Good")
		// A dangling "Reason:" label with nothing after it is not rendered.
		expect(text).not.toContain("Reason:")
	})

	it("returns undefined when entry data is missing", () => {
		const container = feedbackSummaryRenderer(makeEntry(undefined), makeOptions(), makeTheme())
		expect(container).toBeUndefined()
	})

	it("renders the single-line invitation when model-switch summary has no reason", () => {
		const details: ModelSwitchSummaryDetails = {
			model: "Concrete",
			reason: "",
		}
		const container = feedbackSummaryRenderer(makeEntry(details), makeOptions(), makeTheme())
		const text = container?.render(80).map(stripAnsi).join("\n") ?? ""
		expect(text).toContain("Tell us why you switched to Concrete (Ctrl+R)")
		expect(text).not.toContain("Switched to Concrete")
		expect(text).not.toContain("Reason:")
	})

	it("renders only the reason when model-switch summary has a reason", () => {
		const details: ModelSwitchSummaryDetails = {
			model: "Concrete",
			reason: "Better at code",
		}
		const container = feedbackSummaryRenderer(makeEntry(details), makeOptions(), makeTheme())
		const text = container?.render(80).map(stripAnsi).join("\n") ?? ""
		expect(text).toContain("Reason: Better at code")
		expect(text).not.toContain("Switched to Concrete")
		expect(text).not.toContain("Tell us why you switched")
	})
})
