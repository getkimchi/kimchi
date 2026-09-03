import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// UX consistency: pasting an image path (or dragging a file into the terminal)
// must behave like pasting the image itself — the input transform attaches it,
// the [Image #N] marker appears in the user message, and the model request
// carries the binary payload (no read-tool round-trip, which can silently drop
// the image). Typed paths without a paste are left alone so filename mentions
// in prose don't auto-attach.
test("pasted image path attaches the image to the user turn", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "typed-image-path",
			models: [
				{
					slug: "vision",
					displayName: "Fake Vision",
					provider: "openai",
					reasoning: false,
					input: ["text", "image"],
					contextWindow: 8192,
					maxTokens: 1024,
				},
			],
			initialModel: "vision",
			responses: [{ stream: ["I can see your typed image."] }],
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "cat.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
			},
		},
		async (fixture, trace) => {
			// Simulate a paste (or drag-and-drop) by wrapping the path in the
			// standard terminal bracketed-paste sequences. The editor strips the
			// markers, but the extension sees them in the raw terminal input and
			// treats the submission as pasted.
			terminal.write("\x1b[200~cat.png\x1b[201~")
			terminal.submit("")
			trace.step("submitted pasted image path prompt")

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
