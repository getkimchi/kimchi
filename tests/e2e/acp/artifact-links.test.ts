// ACP integration: generated-artifact links.
//
// When a turn produces an allowlisted, user-openable file (write/edit path or
// path mentioned in bash output), the turn's flush emits a `resource_link`
// chunk carrying `_meta["kimchi.dev"].type = "artifact"` so clients can render
// an "Open <name>" action. This test drives the real binary end-to-end and
// asserts the wire shape the client observes.

import { utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

type ArtifactChunk = {
	messageId?: string
	content: { type: string; uri?: string; name?: string; mimeType?: string }
	meta: Record<string, unknown>
}

function artifactChunks(fixture: AcpFixture, sessionId: string): ArtifactChunk[] {
	return fixture.client.sessionUpdates.flatMap((u) => {
		if (u.sessionId !== sessionId || u.update.sessionUpdate !== "agent_message_chunk") return []
		const update = u.update as {
			messageId?: string
			content?: { type?: string; uri?: string; name?: string; mimeType?: string }
			_meta?: { "kimchi.dev"?: Record<string, unknown> }
		}
		const meta = update._meta?.["kimchi.dev"]
		if (meta?.type !== "artifact" || update.content?.type !== "resource_link") return []
		return [
			{
				messageId: update.messageId,
				content: update.content as ArtifactChunk["content"],
				meta,
			},
		]
	})
}

describe("ACP integration — generated artifact links", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "artifact-links",
			extraArgs: ["--yolo"],
			responses: [
				{
					stream: ["Creating the report."],
					toolCalls: [
						{
							function: {
								name: "write",
								arguments: JSON.stringify({ path: "report.md", content: "# Report\n" }),
							},
						},
					],
				},
				{ stream: ["The report is ready."] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("emits a resource_link chunk with artifact meta for a written file", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Write report.md")
		expect(result.stopReason, "turn stop reason").toBe("end_turn")

		const chunks = artifactChunks(fixture, sessionId)
		expect(chunks, "exactly one artifact chunk").toHaveLength(1)
		expect(chunks[0].content).toMatchObject({
			type: "resource_link",
			name: "report.md",
			uri: pathToFileURL(join(fixture.workDir, "report.md")).href,
			mimeType: "text/markdown",
		})
		// Attached to the replicated text block id, not a fresh message id.
		const textIds = fixture.client.sessionUpdates
			.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk")
			.map((u) => (u.update as { messageId?: string }).messageId)
		expect(textIds).toContain(chunks[0].messageId)
	})
})

// Bash-sniffed artifacts end-to-end: a real command runs in the fixture
// workdir, its output path tokens are sniffed, and the mtime window / git
// exclusion decide whether a chip is emitted.
describe("ACP integration — artifact links from bash output", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "artifact-links-bash",
			extraArgs: ["--yolo"],
			responses: [
				// Turn 1: generates out/report.pdf and prints the relative path.
				{
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: "mkdir -p out && printf x > out/report.pdf && echo 'wrote out/report.pdf'",
								}),
							},
						},
					],
				},
				{ stream: ["Report generated."] },
				// Turn 2: reads the pre-existing stale notes.md (no production).
				{
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "cat notes.md && echo 'see notes.md'" }),
							},
						},
					],
				},
				{ stream: ["Nothing new."] },
				// Turn 3: tree-materializing git command mentioning a file.
				{
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: "git stash pop || true; echo 'restored notes.md'",
								}),
							},
						},
					],
				},
				{ stream: ["Stash handled."] },
				// Turn 4: generates inside a navigated directory (leading cd).
				{
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: "cd out && printf y > deck.pptx && echo 'wrote deck.pptx'",
								}),
							},
						},
					],
				},
				{ stream: ["Deck generated."] },
				// Turn 5: call 1 produces the file (passes detection), call 2
				// deletes it — only the flush-time re-check can drop the chip.
				{
					toolCalls: [
						{
							// Distinct id/index: the fake server defaults both to
							// "call_fake"/0, which would merge the two calls.
							id: "call_produce",
							index: 0,
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: "printf z > temp.pdf && echo 'wrote temp.pdf'",
								}),
							},
						},
						{
							id: "call_cleanup",
							index: 1,
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "rm temp.pdf && echo cleaned" }),
							},
						},
					],
				},
				{ stream: ["Temp handled."] },
			],
		})
		// Pre-existing file with an mtime clearly before any turn starts.
		const stale = join(fixture.workDir, "notes.md")
		writeFileSync(stale, "old")
		const past = Date.now() - 60_000
		utimesSync(stale, new Date(past), new Date(past))
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("emits a chip for a file the command produced", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		expect((await prompt(fixture, sessionId, "Generate the report")).stopReason).toBe("end_turn")
		const chunks = artifactChunks(fixture, sessionId)
		expect(chunks, "exactly one artifact chunk").toHaveLength(1)
		expect(chunks[0].content).toMatchObject({
			name: "report.pdf",
			uri: pathToFileURL(join(fixture.workDir, "out/report.pdf")).href,
			mimeType: "application/pdf",
		})
	})

	it("emits no chip for a read-only mention of a pre-existing file", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		await prompt(fixture, sessionId, "Generate the report") // consume turn 1
		expect((await prompt(fixture, sessionId, "Show notes")).stopReason).toBe("end_turn")
		const chunks = artifactChunks(fixture, sessionId)
		expect(chunks, "only the produced report.pdf from turn 1").toHaveLength(1)
		expect(chunks[0].content.name).toBe("report.pdf")
	})

	it("emits no chip for a tree-materializing git command", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		await prompt(fixture, sessionId, "Generate the report")
		await prompt(fixture, sessionId, "Show notes")
		// Fresh mtime: the window passes, so only the git exclusion can
		// suppress the chip — this is what the test must pin.
		const notes = join(fixture.workDir, "notes.md")
		const now = Date.now()
		utimesSync(notes, new Date(now), new Date(now))
		expect((await prompt(fixture, sessionId, "Pop the stash")).stopReason).toBe("end_turn")
		const chunks = artifactChunks(fixture, sessionId)
		expect(chunks.every((c) => c.content.name === "report.pdf")).toBe(true)
	})

	it("emits no chip for a file deleted by a later tool call in the turn", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		await prompt(fixture, sessionId, "Generate the report")
		await prompt(fixture, sessionId, "Show notes")
		await prompt(fixture, sessionId, "Pop the stash")
		await prompt(fixture, sessionId, "Generate the deck") // consume turn 4
		expect((await prompt(fixture, sessionId, "Make a temp file")).stopReason).toBe("end_turn")
		const chunks = artifactChunks(fixture, sessionId)
		expect(chunks.every((c) => c.content.name !== "temp.pdf")).toBe(true)
	})

	it("resolves output paths inside a leading-cd directory", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		await prompt(fixture, sessionId, "Generate the report")
		await prompt(fixture, sessionId, "Show notes")
		await prompt(fixture, sessionId, "Pop the stash")
		expect((await prompt(fixture, sessionId, "Generate the deck")).stopReason).toBe("end_turn")
		const chunks = artifactChunks(fixture, sessionId)
		const deck = chunks.find((c) => c.content.name === "deck.pptx")
		expect(deck, "deck chip exists").toBeDefined()
		expect(deck?.content.uri).toBe(pathToFileURL(join(fixture.workDir, "out/deck.pptx")).href)
	})
})
