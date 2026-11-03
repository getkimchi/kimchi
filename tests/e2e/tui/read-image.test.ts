// Regression test for the read tool's image inlining in the compiled binary.
//
// images larger than the inline limits must be resized by Photon, which loads its
// WASM from $execDir/photon_rs_bg.wasm (pi patches fs.readFileSync to fall back to
// the directory of the executable). If scripts/build-binary.js fails to bundle the
// WASM next to the binary, every image read returns the omit message instead of an
// image content block — the model sees nothing.
//
// This test scripts a `read` tool call against a 2100x2100 PNG (larger than the
// 2000px display limit, so it actually exercises Photon resize, not the under-limits
// fast path) and asserts the outgoing provider request carries an image part and
// not the omit message.

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { makeSolidPng } from "./support/png.js"

test.use(TUI_TEST_CONFIG)

const VISION_MODEL = { slug: "vision", displayName: "Fake Vision", input: ["text", "image"] as ("text" | "image")[] }

test("read tool sends the resized image to the provider instead of the omit message", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "read-image",
			models: [VISION_MODEL],
			initialModel: VISION_MODEL.slug,
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "big.png"), makeSolidPng(2100, 2100))
			},
			responses: [
				{
					toolCalls: [
						{
							id: "call_read_image",
							function: { name: "read", arguments: JSON.stringify({ path: "big.png" }) },
						},
					],
				},
				{ stream: ["Read the image."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("read big.png")
			await waitForText(terminal, "Read the image.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("read tool round-trip completed")

			// The tool result must reach the provider as an image part, not the omit message.
			// Assert on the parsed request structure, not on JSON text formatting.
			type Message = { role?: string; content?: unknown }
			const parseBody = (body: unknown): { messages?: Message[] } =>
				typeof body === "string" ? JSON.parse(body) : ((body ?? {}) as { messages?: Message[] })
			const bodies = fixture.fake.requests
				.filter((r) => r.url.includes("/chat/completions"))
				.map((r) => parseBody(r.body))
			expect(bodies.some((b) => b.messages?.some((m) => m.role === "tool"))).toBe(true)
			const parts = bodies.flatMap((b) =>
				(b.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content])),
			)
			const texts = parts
				.map((p) =>
					typeof p === "string" ? p : typeof p === "object" && p !== null ? (p as { text?: string }).text : "",
				)
				.filter((t): t is string => typeof t === "string")
			expect(texts.join("\n")).not.toContain("[Image omitted")
			const imageParts = parts.filter(
				(p) => typeof p === "object" && p !== null && (p as { type?: string }).type === "image_url",
			)
			expect(imageParts.length).toBeGreaterThan(0)
			trace.step("provider request carries the resized image")
		},
	)
})
