import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText, waitForTurnToSettle } from "./support/assertions.js"
import type { RecordedRequest } from "./support/fake-openai-server.js"
import { launchKimchi, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { makeSolidPng } from "./support/png.js"

test.use(TUI_TEST_CONFIG)

const VISION = { slug: "vision", displayName: "Fake Vision", input: ["text", "image"], contextWindow: 200_000 }
const TEXT = { slug: "text", displayName: "Fake Text", input: ["text"], contextWindow: 100_000 }
const MODELS = [VISION, TEXT]
const READ_IMAGE_RESPONSE = {
	toolCalls: [{ id: "call_read_image", function: { name: "read", arguments: JSON.stringify({ path: "shot.png" }) } }],
}

function seedImage(_homeDir: string, workDir: string) {
	writeFileSync(join(workDir, "shot.png"), makeSolidPng(16, 16))
}

function chatRequests(fixture: { fake: { requests: RecordedRequest[] } }) {
	return fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
}

function requestModel(request: RecordedRequest | undefined) {
	const body = request?.body as { model?: unknown } | undefined
	return typeof body?.model === "string" ? body.model : undefined
}

function expectDescriptionsWithoutImages(request: RecordedRequest | undefined, description: string) {
	const body = JSON.stringify(request?.body ?? {})
	expect(body).toContain(description)
	expect(body).not.toContain('"image_url"')
}

test("strip-images loads images from a restored session before another model turn", async ({ terminal }) => {
	const exitMarker = "STRIP_IMAGES_RESTORED_EXITED"
	await runKimchiSession(
		terminal,
		{
			artifactName: "strip-images-restored-session",
			models: MODELS,
			initialModel: "vision",
			seedHome: seedImage,
			exitMarker,
			responses: [
				READ_IMAGE_RESPONSE,
				{ stream: ["Read the screenshot."] },
				{ stream: ["A small solid test image."] },
				{ stream: ["Text-only continuation works."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Read shot.png")
			await waitForText(terminal, "Read the screenshot.")
			await waitForTurnToSettle(fixture.fake.requests)
			terminal.submit("/quit")
			await waitForText(terminal, exitMarker)

			launchKimchi(terminal, fixture, ["--continue"], {})
			await waitForText(terminal, PROMPT_READY)
			trace.step("resumed with persisted tool-result image and empty runtime cache")
			terminal.submit("/strip-images")
			await waitForText(terminal, "Stripped 1 image with AI descriptions")
			expect(requestModel(chatRequests(fixture).at(-1))).toBe("vision")

			terminal.submit("/model fake/text")
			await waitForText(terminal, "Model: text")
			terminal.submit("Continue without images")
			await waitForText(terminal, "Text-only continuation works.")
			const requests = chatRequests(fixture)
			expect(requests.map(requestModel)).toEqual(["vision", "vision", "vision", "text"])
			expectDescriptionsWithoutImages(requests.at(-1), "A small solid test image.")
		},
	)
})

test("switching to a text-only model offers stripping before proceeding", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-switch-strips-images",
			models: MODELS,
			initialModel: "vision",
			seedHome: seedImage,
			responses: [
				READ_IMAGE_RESPONSE,
				{ stream: ["Read the screenshot."] },
				{ stream: ["A screenshot ready for text context."] },
				{ stream: ["Switched without images."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Read shot.png")
			await waitForText(terminal, "Read the screenshot.")
			await waitForTurnToSettle(fixture.fake.requests)
			terminal.submit("/model fake/text")
			await waitForText(terminal, "Strip images and switch")
			trace.step("text-only switch waits for explicit stripping consent")

			terminal.submit("")
			await waitForText(terminal, "Model: text")
			terminal.submit("Continue without images")
			await waitForText(terminal, "Switched without images.")
			const requests = chatRequests(fixture)
			expect(requests.map(requestModel)).toEqual(["vision", "vision", "vision", "text"])
			expectDescriptionsWithoutImages(requests.at(-1), "A screenshot ready for text context.")
		},
	)
})

test("compaction without retained images switches without stripping", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-switch-compacts-images-away",
			models: MODELS,
			initialModel: "vision",
			seedHome: (homeDir, workDir) => {
				seedImage(homeDir, workDir)
				const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
				settings.compaction = { keepRecentTokens: 8_000 }
				writeFileSync(settingsPath, JSON.stringify(settings, null, "\t"), "utf-8")
			},
			responses: [
				{ stream: ["Older context recorded."] },
				READ_IMAGE_RESPONSE,
				{ stream: ["Read the screenshot."], usage: { prompt_tokens: 150_000, completion_tokens: 5 } },
				{ stream: ["Compacted context without image blocks."] },
				{ stream: ["Compacted text-only continuation works."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Prime older context")
			await waitForText(terminal, "Older context recorded.")
			terminal.submit("Read shot.png")
			await waitForText(terminal, "Read the screenshot.")
			await waitForTurnToSettle(fixture.fake.requests)
			terminal.submit("/model fake/text")
			await waitForText(terminal, "Compact conversation and continue")
			trace.step("overflow prompt precedes image recovery")

			terminal.submit("")
			await waitForText(terminal, "Model: text")
			trace.step("no images survived compaction so no second consent is needed")
			terminal.submit("Continue after combined recovery")
			await waitForText(terminal, "Compacted text-only continuation works.")

			const requests = chatRequests(fixture)
			expect(requests.map(requestModel)).toEqual(["vision", "vision", "vision", "vision", "text"])
			const finalBody = JSON.stringify(requests.at(-1)?.body ?? {})
			expect(finalBody).toContain("Compacted context without image blocks.")
			expect(finalBody).not.toContain('"image_url"')
		},
	)
})
