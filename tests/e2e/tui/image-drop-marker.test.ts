import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import type { FakeModel } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// A real 8x8 red RGB PNG (well-formed IHDR/IDAT/IEND with CRCs). Upstream pi
// validates attached images via processImage (dist/utils/image-process.js),
// which resizes through Photon/WASM; signature-only stubs no longer pass.
const VALID_PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC",
	"base64",
)

const VISION_MODEL: FakeModel = {
	slug: "vision",
	displayName: "Fake Vision",
	provider: "openai",
	reasoning: false,
	input: ["text", "image"],
	contextWindow: 8192,
	maxTokens: 1024,
}

// Dragging an image file onto the terminal delivers a bracketed paste of the
// file path. The editor must render an inline [Image #N] marker at the drop
// position — never the raw path — and the submission attaches the image
// exactly once under that same number.
test("dropped image renders as [Image #1] instead of the file path", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "image-drop-marker",
			models: [VISION_MODEL],
			initialModel: "vision",
			responses: [{ stream: ["I can see your dropped image."] }],
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "cat.png"), VALID_PNG_BYTES)
			},
		},
		async (fixture, trace) => {
			// Simulate the terminal drop: a single-chunk bracketed paste of the path.
			terminal.write(`\x1b[200~${join(fixture.workDir, "cat.png")}\x1b[201~`)
			trace.step("dropped image path into the prompt")

			// The editor shows the marker, not the raw path.
			await waitForText(terminal, "[Image #1]")
			await expect(waitForText(terminal, "cat.png", { timeoutMs: 2000 })).rejects.toThrow()
			trace.step("inline marker visible, path hidden")

			terminal.write(" what's this?")
			terminal.submit("")
			trace.step("submitted drop prompt")

			await waitForText(terminal, "I can see your dropped image.")
			trace.step("fake reply visible")

			// Behaviour-level evidence: one image payload, marker inline, no path text.
			const chatBodies = fixture.fake.requests
				.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
				.map((request) => JSON.stringify(request.body))
			expect(chatBodies.some((body) => body.includes('"image_url"'))).toBe(true)
			expect(chatBodies.some((body) => body.includes("[Image #1]"))).toBe(true)
			expect(chatBodies.some((body) => body.includes("cat.png"))).toBe(false)
		},
	)
})

// A single backspace right after a dropped-image marker deletes the whole
// marker and detaches the pending image — the submission carries no payload.
test("backspace after a dropped-image marker deletes it atomically and detaches the image", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "image-drop-backspace",
			models: [VISION_MODEL],
			initialModel: "vision",
			responses: [{ stream: ["No image attached."] }],
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "cat.png"), VALID_PNG_BYTES)
			},
		},
		async (fixture, trace) => {
			terminal.write(`\x1b[200~${join(fixture.workDir, "cat.png")}\x1b[201~`)
			await waitForText(terminal, "[Image #1]")
			trace.step("drop marker visible")

			// One backspace removes the whole marker (and with it the attachment),
			// not just the closing bracket.
			terminal.write("\x7f")
			terminal.write("no image now")
			terminal.submit("")
			trace.step("backspaced the marker and submitted")

			await waitForText(terminal, "No image attached.")
			const chatBodies = fixture.fake.requests
				.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
				.map((request) => JSON.stringify(request.body))
			expect(chatBodies.some((body) => body.includes('"image_url"'))).toBe(false)
			expect(chatBodies.some((body) => body.includes("[Image #1]"))).toBe(false)
			expect(chatBodies.some((body) => body.includes("no image now"))).toBe(true)
		},
	)
})

// alt+backspace (delete-word) must remove a marker just as atomically as
// plain backspace — upstream would otherwise stop at the marker's inner word
// boundary and leave the attachment alive.
test("alt+backspace after a dropped-image marker deletes it atomically and detaches the image", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "image-drop-alt-backspace",
			models: [VISION_MODEL],
			initialModel: "vision",
			responses: [{ stream: ["No image attached."] }],
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "cat.png"), VALID_PNG_BYTES)
			},
		},
		async (fixture, trace) => {
			terminal.write(`\x1b[200~${join(fixture.workDir, "cat.png")}\x1b[201~`)
			await waitForText(terminal, "[Image #1]")
			trace.step("drop marker visible")

			terminal.write("\x1b\x7f") // alt+backspace
			terminal.write("no image now")
			terminal.submit("")
			trace.step("alt+backspaced the marker and submitted")

			await waitForText(terminal, "No image attached.")
			const chatBodies = fixture.fake.requests
				.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
				.map((request) => JSON.stringify(request.body))
			expect(chatBodies.some((body) => body.includes('"image_url"'))).toBe(false)
			expect(chatBodies.some((body) => body.includes("[Image #1]"))).toBe(false)
		},
	)
})

// Undoing the drop's insertion removes the marker in one ctrl+z and detaches
// the pending image — the submission carries no payload.
test("undo after a dropped-image marker removes it and detaches the image", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "image-drop-undo",
			models: [VISION_MODEL],
			initialModel: "vision",
			responses: [{ stream: ["No image attached."] }],
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "cat.png"), VALID_PNG_BYTES)
			},
		},
		async (fixture, trace) => {
			terminal.write(`\x1b[200~${join(fixture.workDir, "cat.png")}\x1b[201~`)
			await waitForText(terminal, "[Image #1]")
			trace.step("drop marker visible")

			// The editor's undo is ctrl+- (\x1f); it removes the marker insertion
			// in one step.
			terminal.write("\x1f")
			terminal.write("no image now")
			terminal.submit("")
			trace.step("undid the drop and submitted")

			await waitForText(terminal, "No image attached.")
			const chatBodies = fixture.fake.requests
				.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
				.map((request) => JSON.stringify(request.body))
			expect(chatBodies.some((body) => body.includes('"image_url"'))).toBe(false)
			expect(chatBodies.some((body) => body.includes("[Image #1]"))).toBe(false)
		},
	)
})

// A `[Image #N]` marker typed in a later turn references that earlier turn's
// attachment: the image is re-attached from the registry, not dropped as text.
test("a typed [Image #1] marker re-attaches the earlier turn's image", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "image-drop-registry-reference",
			models: [VISION_MODEL],
			initialModel: "vision",
			responses: [{ stream: ["First answer."] }, { stream: ["Second answer."] }],
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "cat.png"), VALID_PNG_BYTES)
			},
		},
		async (fixture, trace) => {
			terminal.write(`\x1b[200~${join(fixture.workDir, "cat.png")}\x1b[201~`)
			await waitForText(terminal, "[Image #1]")
			terminal.submit("")
			await waitForText(terminal, "First answer.")
			trace.step("first turn attached the dropped image")

			terminal.write("[Image #1] look once more")
			terminal.submit("")
			await waitForText(terminal, "Second answer.")
			trace.step("second turn referenced the image by marker")

			const bodies = fixture.fake.requests
				.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
				.map((request) => request.body) as {
				messages: { role: string; content: unknown }[]
			}[]
			expect(bodies.length).toBe(2)
			const second = bodies[1]
			expect(second).toBeDefined()
			const lastMessage = second?.messages[second.messages.length - 1]
			const lastContent = JSON.stringify(lastMessage?.content)
			expect(lastContent).toContain("[Image #1] look once more")
			expect(lastContent).toContain('"image_url"')
		},
	)
})

// A paste payload that is not a single local image file must fall through to
// the upstream text insertion unchanged.
test("dropping a non-image file inserts the path as plain text", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "image-drop-non-image",
			models: [VISION_MODEL],
			initialModel: "vision",
			responses: [{ stream: ["Got the notes."] }],
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "notes.txt"), "hello")
			},
		},
		async (fixture, trace) => {
			terminal.write(`\x1b[200~${join(fixture.workDir, "notes.txt")}\x1b[201~`)
			trace.step("dropped non-image path into the prompt")

			await waitForText(terminal, "notes.txt")
			await expect(waitForText(terminal, "[Image #1]", { timeoutMs: 2000 })).rejects.toThrow()
			trace.step("raw path visible, no marker")

			terminal.submit("")
			await waitForText(terminal, "Got the notes.")

			const chatBodies = fixture.fake.requests
				.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
				.map((request) => JSON.stringify(request.body))
			expect(chatBodies.some((body) => body.includes('"image_url"'))).toBe(false)
		},
	)
})
