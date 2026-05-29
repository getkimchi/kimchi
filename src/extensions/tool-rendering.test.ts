import { type Theme, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { beforeAll, describe, expect, it } from "vitest"
import { patchUserMessageRender, splitLeadingOsc133Markers, summarizeOpenAiToolCall } from "./tool-rendering.js"

const OSC133_A = "\x1b]133;A\x07"
const OSC133_B = "\x1b]133;B\x07"
const OSC133_C = "\x1b]133;C\x07"
const SGR_RE = new RegExp(`${"\x1b"}\\[[0-9;]*m`, "g")

const stripSgr = (line: string): string => line.replace(SGR_RE, "")
const plainTheme = {
	fg: (_name: string, value: string) => value,
} as unknown as Theme

describe("user message render patch", () => {
	beforeAll(() => {
		initTheme("default")
		patchUserMessageRender()
	})

	it("splits all leading OSC 133 markers from one-line user messages", () => {
		const line = `${OSC133_B}${OSC133_C}${OSC133_A}hello`

		expect(splitLeadingOsc133Markers(line)).toEqual({
			markers: `${OSC133_B}${OSC133_C}${OSC133_A}`,
			rest: "hello",
		})
	})

	it("keeps OSC 133 markers before the visible prompt prefix", () => {
		const lines = new UserMessageComponent("do we have unpushed commits?").render(80)

		expect(lines).toHaveLength(1)
		const { markers, rest } = splitLeadingOsc133Markers(lines[0])
		expect(markers).toBe(`${OSC133_B}${OSC133_C}${OSC133_A}`)
		expect(stripSgr(rest).startsWith(" ❯ do we have unpushed commits?")).toBe(true)
		expect(visibleWidth(lines[0])).toBe(80)
	})

	it("summarizes questionnaire calls from prompt fields", () => {
		const summary = summarizeOpenAiToolCall(
			"questionnaire",
			{ questions: [{ prompt: "Which improvement areas should this ferment include?" }] },
			plainTheme,
			(path) => path,
		)

		expect(summary).toBe("Which improvement areas should this ferment include?")
	})
})
