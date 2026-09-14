import { describe, expect, it } from "vitest"
import {
	buildRemoteSessionDispatchInstruction,
	parseRemoteSessionTrigger,
	REMOTE_SESSION_TRIGGERS,
} from "./remote-session-trigger.js"

describe("parseRemoteSessionTrigger", () => {
	it("matches the bare trigger phrase", () => {
		expect(parseRemoteSessionTrigger("continue in remote session")).toEqual({})
	})

	it("matches case-insensitively", () => {
		expect(parseRemoteSessionTrigger("Continue in Remote Session")).toEqual({})
	})

	it("captures focus after a colon", () => {
		expect(parseRemoteSessionTrigger("continue in remote session: focus on the auth refactor")).toEqual({
			focus: "focus on the auth refactor",
		})
	})

	it("captures focus after an em-dash", () => {
		expect(parseRemoteSessionTrigger("continue in remote session — cover step 3")).toEqual({
			focus: "cover step 3",
		})
	})

	it("captures focus after a period", () => {
		expect(parseRemoteSessionTrigger("continue in remote session. Use the plan from earlier")).toEqual({
			focus: "Use the plan from earlier",
		})
	})

	it("returns no focus when only separators follow", () => {
		expect(parseRemoteSessionTrigger("continue in remote session.")).toEqual({})
	})

	it("rejects when the phrase continues with word characters", () => {
		expect(parseRemoteSessionTrigger("continue in remote sessions please")).toBeUndefined()
	})

	it("rejects when the phrase is not a prefix", () => {
		expect(parseRemoteSessionTrigger("please continue in remote session")).toBeUndefined()
	})

	it("rejects unrelated prompts", () => {
		expect(parseRemoteSessionTrigger("implement the login feature")).toBeUndefined()
	})

	it("matches the 'implement this feature using cloud agent' phrase", () => {
		expect(parseRemoteSessionTrigger("Implement this feature using cloud agent")).toEqual({})
	})

	it("captures focus after the cloud-agent phrase", () => {
		expect(parseRemoteSessionTrigger("implement this feature using cloud agent: the auth flow")).toEqual({
			focus: "the auth flow",
		})
	})

	it("rejects word-continuation after the cloud-agent phrase", () => {
		expect(parseRemoteSessionTrigger("implement this feature using cloud agents")).toBeUndefined()
	})
})

describe("REMOTE_SESSION_TRIGGERS", () => {
	it("lists phrases longest-first so the most specific match wins", () => {
		const lengths = [...REMOTE_SESSION_TRIGGERS].map((t) => t.length)
		expect(lengths).toEqual([...lengths].sort((a, b) => b - a))
	})

	it("contains the expected phrases in lowercase", () => {
		expect(REMOTE_SESSION_TRIGGERS).toContain("continue in remote session")
		expect(REMOTE_SESSION_TRIGGERS).toContain("implement this feature using cloud agent")
		for (const phrase of REMOTE_SESSION_TRIGGERS) {
			expect(phrase).toBe(phrase.toLowerCase())
		}
	})
})

describe("buildRemoteSessionDispatchInstruction", () => {
	it("includes the original request and the dispatch tool name", () => {
		const text = buildRemoteSessionDispatchInstruction("continue in remote session")
		expect(text).toContain("continue in remote session")
		expect(text).toContain("dispatch_to_cloud_agent")
		expect(text).toContain("NO access to this conversation")
	})

	it("quotes the focus when provided", () => {
		const text = buildRemoteSessionDispatchInstruction("continue in remote session: auth", "auth")
		expect(text).toContain('focus for the handoff — prioritize it when deciding what context to include: "auth"')
	})

	it("uses the generic context guidance when no focus is given", () => {
		const text = buildRemoteSessionDispatchInstruction("continue in remote session")
		expect(text).toContain("Include the context from this conversation needed to complete the task")
		expect(text).not.toContain("focus for the handoff")
	})
})
