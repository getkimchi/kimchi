import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import type { FakeModel } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const VISION_MODEL: FakeModel = {
	slug: "vision",
	displayName: "Fake Vision",
	provider: "openai",
	reasoning: false,
	input: ["text", "image"],
	contextWindow: 8192,
	maxTokens: 1024,
}

// A local image file path typed (or pasted/dropped) into the prompt must behave
// like pasting the image itself: the input transform attaches the file, the
// [Image #N] marker appears in the user message, and the model request carries
// the binary payload (no read-tool round-trip, which can silently drop the
// image). Prose that names a path which does not resolve to an image file must
// be left untouched so the read tool stays the loud fallback.
test("typed image path attaches the image to the user turn", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "typed-image-path",
			models: [VISION_MODEL],
			initialModel: "vision",
			responses: [{ stream: ["I can see your typed image."] }],
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "cat.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
			},
		},
		async (fixture, trace) => {
			terminal.write("cat.png what's this?")
			terminal.submit("")
			trace.step("submitted image path prompt")

			// User-visible evidence: the attached image's marker prefixes the message.
			await waitForText(terminal, "[Image #1]")
			await waitForText(terminal, "I can see your typed image.")
			trace.step("image marker and fake reply visible")

			// Behaviour-level evidence: the completion request carried the image.
			const chatBodies = fixture.fake.requests
				.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
				.map((request) => JSON.stringify(request.body))
			expect(chatBodies.some((body) => body.includes('"image_url"'))).toBe(true)
		},
	)
})

test("mentioning a non-existent image path does not attach anything", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "typed-image-path-missing",
			models: [VISION_MODEL],
			initialModel: "vision",
			responses: [{ stream: ["Nothing attached."] }],
		},
		async (fixture, trace) => {
			terminal.write("please open missing.png")
			terminal.submit("")
			trace.step("submitted prose mentioning a missing image file")

			await waitForText(terminal, "Nothing attached.")
			trace.step("fake reply visible")

			// The missing file was skipped: no marker, no image payload in the request.
			await expect(waitForText(terminal, "[Image #1]", { timeoutMs: 2000 })).rejects.toThrow()
			const chatBodies = fixture.fake.requests
				.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
				.map((request) => JSON.stringify(request.body))
			expect(chatBodies.some((body) => body.includes('"image_url"'))).toBe(false)
		},
	)
})
