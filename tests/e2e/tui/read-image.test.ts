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
import { crc32, deflateSync } from "node:zlib"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

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
			const withToolResult = fixture.fake.requests.filter(
				(r) => r.url.includes("/chat/completions") && JSON.stringify(r.body).includes('"role":"tool"'),
			)
			expect(withToolResult.length).toBeGreaterThan(0)
			const body = JSON.stringify(withToolResult.map((r) => r.body))
			expect(body).not.toContain("[Image omitted")
			expect(body).toContain('"type":"image_url"')
			trace.step("provider request carries the resized image")
		},
	)
})

/** Minimal deterministic PNG encoder: solid-color RGB, no filters. */
function makeSolidPng(width: number, height: number): Buffer {
	const stride = width * 3 + 1
	const raw = Buffer.alloc(stride * height)
	for (let y = 0; y < height; y++) {
		const row = y * stride
		raw[row] = 0 // filter: none
		for (let x = 0; x < width; x++) {
			raw[row + 1 + x * 3] = 0x7a
			raw[row + 2 + x * 3] = 0x3f
			raw[row + 3 + x * 3] = 0x21
		}
	}

	const chunk = (type: string, data: Buffer): Buffer => {
		const len = Buffer.alloc(4)
		len.writeUInt32BE(data.length)
		const body = Buffer.concat([Buffer.from(type, "ascii"), data])
		const crc = Buffer.alloc(4)
		crc.writeUInt32BE(crc32(body) >>> 0)
		return Buffer.concat([len, body, crc])
	}

	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(width, 0)
	ihdr.writeUInt32BE(height, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 2 // color type: truecolor RGB

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	])
}
