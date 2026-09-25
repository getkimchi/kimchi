/**
 * E2E TUI tests: vision-model gating for image attachments.
 *
 * When a submission carries images and the current model is text-only, the
 * submit-time gate offers a searchable vision-model switch with
 * remove/cancel alternatives, informed compaction for small-context targets,
 * and a deferred prompt for submissions intercepted mid-stream.
 *
 * Typed-path scenarios use a small PNG seeded into the workDir. The paste
 * scenario points the child process's explicit E2E clipboard seam at that file,
 * then drives Ctrl+V through the real editor and extension path.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import type { FakeModel, RecordedRequest } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** Text-only initial model; window large enough that priming never auto-compacts. */
const TEXT_MODEL: FakeModel = {
	slug: "text-basic",
	displayName: "Fake Text Basic",
	input: ["text"],
	contextWindow: 64_000,
	maxTokens: 4_096,
}

/** Comfortable vision model — the usual switch target. */
const VISION_MODEL: FakeModel = {
	slug: "vision-basic",
	displayName: "Fake Vision Basic",
	input: ["text", "image"],
	contextWindow: 200_000,
	maxTokens: 4_096,
}

/** Small vision model whose safe window a primed context exceeds. */
const VISION_SMALL: FakeModel = {
	slug: "vision-small",
	displayName: "Fake Vision Small",
	input: ["text", "image"],
	contextWindow: 8_192,
	maxTokens: 4_096,
}

const MODELS = [TEXT_MODEL, VISION_MODEL, VISION_SMALL]

const GATE_TITLE = "Switch to a vision model"
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Seed the image + (optionally) small keepRecent compaction settings. */
function seedScenario(options: { image?: boolean; clipboardImage?: boolean; smallKeepRecent?: boolean } = {}) {
	return (homeDir: string, workDir: string) => {
		const imagePath = join(workDir, "photo.png")
		if (options.image !== false) {
			writeFileSync(imagePath, PNG_BYTES)
		}
		if (options.smallKeepRecent) {
			const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
			// Small keepRecent so the gate's inline compaction has a summarizable
			// prefix at modest context sizes (same trick as the overflow-recovery
			// e2e; the gate itself uses default compaction settings).
			settings.compaction = { keepRecentTokens: 1_000 }
			writeFileSync(settingsPath, JSON.stringify(settings, null, "\t"), "utf-8")
		}
		return options.clipboardImage ? { env: { KIMCHI_TUI_E2E_CLIPBOARD_IMAGE: imagePath } } : {}
	}
}

function chatRequests(fixture: { fake: { requests: RecordedRequest[] } }): RecordedRequest[] {
	return fixture.fake.requests.filter(
		(request) => request.method === "POST" && request.url.startsWith("/openai/v1/chat/completions"),
	)
}

async function waitForChatRequest(
	fixture: { fake: { requests: RecordedRequest[] } },
	minimumCount = 1,
	timeoutMs = INPUT_TIMEOUT_MS,
): Promise<RecordedRequest[]> {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		const requests = chatRequests(fixture)
		if (requests.length >= minimumCount) return requests
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error(`Timed out waiting for ${minimumCount} chat completion request(s)`)
}

function requestModel(request: RecordedRequest): string | undefined {
	const body = request.body as { model?: unknown } | null
	return body && typeof body === "object" && typeof body.model === "string" ? body.model : undefined
}

function requestHasImage(request: RecordedRequest): boolean {
	return JSON.stringify(request.body ?? "").includes('"image_url"')
}

/** Long filler prompt that pushes the estimated context past a small model's window. */
function largePrompt(base: string, tokens: number): string {
	const chunk = "one two three four five six seven eight nine ten "
	const repeats = Math.ceil((tokens * 4) / chunk.length)
	return `${base}: ${chunk.repeat(repeats)}`
}

test("pasted image on a text-only model opens the switch dialog and submits on the picked model", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "vision-gate-switch",
			models: MODELS,
			initialModel: "text-basic",
			responses: [{ stream: ["Ack on vision."], usage: { prompt_tokens: 120, completion_tokens: 6 } }],
			seedHome: seedScenario({ clipboardImage: true }),
		},
		async (fixture, trace) => {
			terminal.keyPress("v", { ctrl: true })
			await waitForText(terminal, "📎 1 image", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("image pasted while the text-only model is active")

			terminal.submit("what is in this image?")
			await waitForText(terminal, GATE_TITLE, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("gate dialog visible on submit")

			// Filter to the comfortable vision model and select it.
			terminal.write("vision-b")
			await waitForText(terminal, "vision-basic", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			trace.step("vision model selected")

			await waitForText(terminal, "Ack on vision.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("submission completed on the new model")

			const requests = await waitForChatRequest(fixture, 1)
			const final = requests[requests.length - 1]
			expect(final).toBeDefined()
			expect(requestModel(final)).toBe("vision-basic")
			expect(requestHasImage(final)).toBe(true)
			expect(JSON.stringify(final.body)).toContain("[Image #1]")
		},
	)
})

test("gate Remove sends the text clean and the next message sends without a dialog", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "vision-gate-remove",
			models: MODELS,
			initialModel: "text-basic",
			responses: [
				{ stream: ["Ack clean."], usage: { prompt_tokens: 60, completion_tokens: 4 } },
				{ stream: ["Ack plain."], usage: { prompt_tokens: 40, completion_tokens: 4 } },
			],
			seedHome: seedScenario(),
		},
		async (fixture, trace) => {
			terminal.submit("what is in photo.png")
			await waitForText(terminal, GATE_TITLE, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("gate dialog visible")

			terminal.keyPress("r", { ctrl: true })
			await waitForText(terminal, "Ack clean.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("remove submitted the text without images")

			const first = (await waitForChatRequest(fixture, 1))[0]
			expect(requestModel(first)).toBe("text-basic")
			expect(requestHasImage(first)).toBe(false)
			// The typed path stays in the message text; only the attachment is dropped.
			expect(JSON.stringify(first.body)).toContain("photo.png")
			expect(JSON.stringify(first.body)).not.toContain("[Image #1]")

			// The next message (no image) sends without any dialog.
			terminal.submit("plain follow-up")
			await waitForText(terminal, "Ack plain.", { timeoutMs: STREAM_TIMEOUT_MS })
			const second = (await waitForChatRequest(fixture, 2))[1]
			expect(requestModel(second)).toBe("text-basic")
			expect(requestHasImage(second)).toBe(false)
			trace.step("next message sent without the dialog")
		},
	)
})

test("gate Cancel restores the draft and resubmitting reopens the dialog", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "vision-gate-cancel",
			models: MODELS,
			initialModel: "text-basic",
			responses: [{ stream: ["Ack after cancel."], usage: { prompt_tokens: 80, completion_tokens: 6 } }],
			seedHome: seedScenario(),
		},
		async (fixture, trace) => {
			terminal.submit("what is in photo.png")
			await waitForText(terminal, GATE_TITLE, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("gate dialog visible")

			terminal.keyEscape()
			// The exact draft is back in the editor — nothing was submitted.
			await waitForText(terminal, "what is in photo.png", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			expect(chatRequests(fixture)).toHaveLength(0)
			trace.step("draft restored, nothing submitted")

			// Resubmitting the retained draft reopens the dialog; switching now
			// completes the submission exactly once.
			terminal.submit("")
			await waitForText(terminal, GATE_TITLE, { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.write("vision-b")
			terminal.submit("")
			await waitForText(terminal, "Ack after cancel.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("resubmit reopened the dialog and completed")

			const requests = await waitForChatRequest(fixture, 1)
			expect(requests).toHaveLength(1)
			const final = requests[0]
			expect(requestModel(final)).toBe("vision-basic")
			expect(requestHasImage(final)).toBe(true)
			expect(JSON.stringify(final.body)).toContain("[Image #1]")
		},
	)
})

test("/model renders MODEL, PROVIDER, CONTEXT, and IMG columns", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "vision-gate-model-table",
			models: MODELS,
			initialModel: "text-basic",
			responses: [],
			seedHome: seedScenario(),
		},
		async (_fixture, trace) => {
			terminal.submit("/model")
			const view = () => viewText(terminal)
			await waitForText(terminal, "MODEL", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "PROVIDER", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "CONTEXT", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "IMG", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("table header visible")

			// Humanized context + capability markers for both kinds of models.
			const text = view()
			expect(text).toContain("200k")
			expect(text).toContain("64k")
			expect(text).toContain("✓")
			expect(text).toContain("✗")
			trace.step("context and IMG values rendered")

			terminal.keyEscape()
			await waitForText(terminal, "ask anything or type / for commands", {
				timeoutMs: STARTUP_TIMEOUT_MS,
				full: false,
			})
		},
	)
})

test("switching to a smaller vision model confirms compaction, compacts, then submits the image", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "vision-gate-compaction",
			models: MODELS,
			initialModel: "text-basic",
			responses: [
				// Prime turns: several exchanges push the context past vision-small's
				// safe window (8192 * 0.95 = 7782 tokens) AND leave pi's compaction a
				// summarizable prefix (a single turn has no cut point).
				{ stream: ["Ack 1."], usage: { prompt_tokens: 3_500, completion_tokens: 6 } },
				{ stream: ["Ack 2."], usage: { prompt_tokens: 6_800, completion_tokens: 6 } },
				{ stream: ["Ack 3."], usage: { prompt_tokens: 10_000, completion_tokens: 6 } },
				// The gate's inline compaction summarization call.
				{ stream: ["Summary of the earlier conversation."] },
				// The original image submission, sent after the switch.
				{ stream: ["Ack on small."], usage: { prompt_tokens: 400, completion_tokens: 6 } },
			],
			seedHome: seedScenario({ smallKeepRecent: true }),
		},
		async (fixture, trace) => {
			// Prime the context across several turns.
			for (let i = 1; i <= 3; i++) {
				terminal.submit(largePrompt(`prime ${i}`, 3_500))
				await waitForText(terminal, `Ack ${i}.`, { timeoutMs: STREAM_TIMEOUT_MS })
			}
			trace.step("context primed")

			// Submit the image; the small vision model needs compaction.
			terminal.submit("look at photo.png")
			await waitForText(terminal, GATE_TITLE, { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.write("small")
			await waitForText(terminal, "vision-small", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "compact", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("compact badge visible on the small model")

			terminal.submit("")
			await waitForText(terminal, "this will compact your context — continue?", {
				timeoutMs: INPUT_TIMEOUT_MS,
				full: false,
			})
			trace.step("two-step compaction confirm shown")
			terminal.keyPress("y")

			// Compaction completes, the switch succeeds, the original submission
			// reaches the new model with the image attached.
			await waitForText(terminal, "Ack on small.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("compaction + switch + submission completed")

			const requests = await waitForChatRequest(fixture, 3)
			// The submission on the new model: image attached, marker prefixed.
			const submitted = requests.find((request) => requestHasImage(request) && requestModel(request) === "vision-small")
			expect(submitted).toBeDefined()
			expect(JSON.stringify(submitted?.body)).toContain("[Image #1]")
			// The gate's inline compaction ran on the old model before the switch.
			const gateCompaction = requests.find(
				(request) =>
					requestModel(request) === "text-basic" &&
					JSON.stringify(request.body ?? "").includes("summarization assistant"),
			)
			expect(gateCompaction).toBeDefined()
			const final = submitted as RecordedRequest
			const compaction = gateCompaction as RecordedRequest
			expect(requests.indexOf(compaction)).toBeLessThan(requests.indexOf(final))
		},
	)
})

test("image submitted mid-stream defers the dialog; after the run, switching sends it once on Enter", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "vision-gate-deferred-switch",
			models: MODELS,
			initialModel: "text-basic",
			responses: [
				{
					stream: ["chunk-1 ", "chunk-2 ", "chunk-3 ", "chunk-4 ", "chunk-5 ", "chunk-6 "],
					delayMs: 250,
					usage: { prompt_tokens: 40, completion_tokens: 12 },
				},
				{ stream: ["Ack deferred."], usage: { prompt_tokens: 90, completion_tokens: 6 } },
			],
			seedHome: seedScenario(),
		},
		async (fixture, trace) => {
			terminal.submit("long answer please")
			await waitForText(terminal, "chunk-1", { timeoutMs: STREAM_TIMEOUT_MS })

			// Submit the image while the run is still streaming.
			terminal.submit("what is in photo.png")
			await waitForText(terminal, "switch available when generation finishes", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "what is in photo.png", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			// No dialog opened mid-stream.
			expect(viewText(terminal)).not.toContain(GATE_TITLE)
			trace.step("mid-stream submission consumed, draft restored, notify shown")

			// The run finishes; the deferred dialog opens. Waiting for the dialog
			// (rather than the last streamed chunk) proves the run completed AND
			// sidesteps the overlay painting over the streamed rows.
			await waitForText(terminal, GATE_TITLE, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("deferred dialog opened after the run")

			terminal.write("vision-b")
			terminal.submit("")
			await waitForText(terminal, "press Enter to send", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("switched; retained draft waits for Enter")

			// The explicit Enter sends the retained image exactly once.
			terminal.submit("")
			await waitForText(terminal, "Ack deferred.", { timeoutMs: STREAM_TIMEOUT_MS })
			const requests = await waitForChatRequest(fixture, 2)
			const final = requests[1]
			expect(requestModel(final)).toBe("vision-basic")
			expect(requestHasImage(final)).toBe(true)
			expect(JSON.stringify(final.body)).toContain("[Image #1]")
			expect(requests.filter(requestHasImage)).toHaveLength(1)
			trace.step("retained image sent exactly once")
		},
	)
})

test("deferred Remove sends the unchanged draft later without reattaching the image", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "vision-gate-deferred-remove",
			models: MODELS,
			initialModel: "text-basic",
			responses: [
				{
					stream: ["chunk-1 ", "chunk-2 ", "chunk-3 ", "chunk-4 "],
					delayMs: 250,
					usage: { prompt_tokens: 40, completion_tokens: 8 },
				},
				{ stream: ["Ack after remove."], usage: { prompt_tokens: 50, completion_tokens: 6 } },
			],
			seedHome: seedScenario(),
		},
		async (fixture, trace) => {
			terminal.submit("long answer please")
			await waitForText(terminal, "chunk-1", { timeoutMs: STREAM_TIMEOUT_MS })

			// Typed image path submitted mid-stream.
			terminal.submit("look at photo.png")
			await waitForText(terminal, "switch available when generation finishes", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("mid-stream submission consumed")

			// The run finishes; the deferred dialog opens; choose Remove.
			await waitForText(terminal, GATE_TITLE, { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.keyPress("r", { ctrl: true })
			trace.step("deferred remove chosen")

			// The next Enter sends the unchanged text WITHOUT the image and
			// without reopening the dialog (the response proves the submission
			// was not gated).
			terminal.submit("")
			await waitForText(terminal, "Ack after remove.", { timeoutMs: STREAM_TIMEOUT_MS })
			const requests = await waitForChatRequest(fixture, 2)
			const final = requests[1]
			expect(requestModel(final)).toBe("text-basic")
			expect(requestHasImage(final)).toBe(false)
			expect(JSON.stringify(final.body)).toContain("photo.png")
			trace.step("unchanged draft sent without reattaching the image")
		},
	)
})
