// ACP integration: resource_link prompt blocks are no longer dropped.
//
// The ACP content spec says agents MUST support resource_link blocks in
// prompts — they are how clients reference files (an @-mention in Zed). The
// model must see the file as `[@name](uri)` text (the reference adapter's
// rendering), positioned in prompt order. Before the fix, the block was
// dropped with a one-time stderr line and the attached file vanished.

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

describe("ACP integration — resource_link prompt blocks", () => {
	let fixture: Awaited<ReturnType<typeof startAcpFixture>>

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "prompt-resource-link",
			responses: [{ stream: ["Ack."] }, { stream: ["Skill loaded."] }],
		})
		writeFileSync(join(fixture.workDir, "attachment.txt"), "see the link\n")
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("renders a resource_link as [@name](uri) text in the model prompt", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Summarize this: ", [
			{ type: "resource_link", uri: `file://${join(fixture.workDir, "attachment.txt")}`, name: "attachment.txt" },
		])
		expect(result.stopReason).toBe("end_turn")

		const first = fixture.fake.requests.find((r) =>
			Array.isArray((r.body as { messages?: unknown } | undefined)?.messages),
		)
		expect(first).toBeDefined()
		const user = (first?.body as { messages?: Array<{ role: string; content: unknown }> })?.messages?.find(
			(m) => m.role === "user",
		)
		const promptText = Array.isArray(user?.content)
			? user.content.map((b) => (b && typeof b === "object" && "text" in b ? b.text : "")).join("")
			: ((user?.content as string | undefined) ?? "")
		expect(promptText).toContain("Summarize this: ")
		expect(promptText).toContain(`[@attachment.txt](file://${join(fixture.workDir, "attachment.txt")})`)
		// Spec's accept criterion: the link renders in prompt order, after the text.
		expect(promptText.indexOf("Summarize this:")).toBeLessThan(promptText.indexOf("[@attachment.txt]("))
	})

	it("still rewrites /skill:<name> when a resource_link precedes the command text", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		// Pre-change semantics: the skill-command parse runs on text blocks only,
		// so a rendered link before the command must not defeat the rewrite.
		const result = await prompt(fixture, sessionId, "/skill:pdf what is a form field?", [
			{ type: "resource_link", uri: `file://${join(fixture.workDir, "attachment.txt")}`, name: "attachment.txt" },
		])
		expect(result.stopReason).toBe("end_turn")

		const first = fixture.fake.requests.find((r) =>
			Array.isArray((r.body as { messages?: unknown } | undefined)?.messages),
		)
		expect(first).toBeDefined()
		const user = (first?.body as { messages?: Array<{ role: string; content: unknown }> })?.messages?.find(
			(m) => m.role === "user",
		)
		const promptText = Array.isArray(user?.content)
			? user.content.map((b) => (b && typeof b === "object" && "text" in b ? b.text : "")).join("")
			: ((user?.content as string | undefined) ?? "")
		expect(promptText).toContain("Invoking skill: pdf")
		expect(promptText).toContain("what is a form field?")
	})

	it("warns once for a still-dropped block type and never for resource_link", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		// Two prompts carrying an audio block: the unsupported-type warning is
		// per connection and per type, so exactly one stderr line — and the
		// renderable resource_link emits none.
		const audio = { type: "audio", mimeType: "audio/wav", data: "UklGRg==" } as const
		await prompt(fixture, sessionId, "First prompt.", [audio])
		await prompt(fixture, sessionId, "Second prompt.", [audio])
		await prompt(fixture, sessionId, "Third prompt.", [
			{ type: "resource_link", uri: `file://${join(fixture.workDir, "attachment.txt")}`, name: "attachment.txt" },
		])
		expect(fixture.agentStderr.match(/dropping audio block/g)?.length ?? 0).toBe(1)
		expect(fixture.agentStderr).not.toContain("dropping resource_link block")
	})
})
