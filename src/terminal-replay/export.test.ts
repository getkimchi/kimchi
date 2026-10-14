import { gunzipSync, gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { addTerminalReplay } from "./export.js"
import type { Recording } from "./recorder.js"

const cast = `${JSON.stringify({ version: 3, term: { cols: 120, rows: 40 } })}\n${JSON.stringify([0.12, "o", '\x1b[2Jraw draft </script><img src="https://example.invalid/leak">'])}\n`
const recording: Recording = {
	gzip: gzipSync(cast).toString("base64"),
	metadata: {
		version: 1,
		id: "recording",
		sessionId: "session",
		pid: 0,
		startedAt: "2026-10-13T10:00:00Z",
		status: "size-limit",
		cols: 120,
		rows: 40,
		chunks: 1,
		rawBytes: Buffer.byteLength(cast),
		compressedBytes: 120,
		duration: 0.12,
		queueHighWaterBytes: 200,
	},
}

describe("HTML terminal replay", () => {
	it("embeds the actual output offline, behind an isolated player, without changing the transcript", async () => {
		const transcript = '<div id="messages">redacted transcript</div>'
		const html = await addTerminalReplay(`<html><body>${transcript}</body></html>`, [recording])
		expect(html).toContain(transcript)
		expect(html).toContain('sandbox="allow-scripts allow-downloads"')
		expect(html).not.toContain("raw draft")
		const encoded = html.match(/id="terminal-replay-document" type="application\/json">([^<]+)/)?.[1]
		expect(encoded).toBeTruthy()
		expect(encoded).toContain(recording.gzip)
		if (!encoded) throw new Error("Replay document missing")
		const player = JSON.parse(encoded)
		expect(player).toContain("unredacted")
		expect(player).toContain("Incomplete: recording stopped at the storage limit.")
		expect(player).toContain("Original pauses preserved")
		expect(player).toContain("connect-src 'none'")
		expect(player).not.toMatch(/<script[^>]+src=/)
		expect(player).not.toContain("/* RECORDINGS */")
		const payload = player.match(/id="recordings" type="application\/json">([^<]+)/)?.[1]
		if (!payload) throw new Error("Replay payload missing")
		const data = JSON.parse(payload)
		expect(gunzipSync(Buffer.from(data[0].gzip, "base64")).toString("utf8")).toBe(cast)
		expect(player).toContain("Permission is hereby granted, free of charge")
		expect(player).not.toContain("AsciinemaPlayer")
		expect(player).not.toContain("wasm-unsafe-eval")
		expect(player).not.toContain("Standalone distribution used without modification.")
	})

	it("explains missing coverage without loading player assets", async () => {
		const html = await addTerminalReplay("<body>old session</body>", [])
		expect(html).toContain("Terminal replay unavailable")
		expect(html).not.toContain("asciinema")
		expect(html).toContain("old session")
	})

	it("embeds saved redacted details safely without changing the recording or transcript", async () => {
		const savedText = '</script><img src=x onerror="alert(1)"> redacted 界 🧑 e\u0301 \u2028\u2029 response'
		const session = Buffer.from(
			JSON.stringify({
				header: { id: "session" },
				entries: [
					{
						type: "message",
						id: "saved",
						parentId: null,
						timestamp: "2026-10-13T10:00:01Z",
						message: {
							role: "assistant",
							timestamp: 100,
							responseId: "response",
							content: [{ type: "text", text: savedText }],
						},
					},
				],
			}),
		).toString("base64")
		const transcript = `<script id="session-data" type="application/json">${session}</script>`
		const traceCast = `${cast}${JSON.stringify([0, "m", JSON.stringify({ type: "kimchi.trace", version: 1, step: 1, kind: "response", messageTimestamp: 100, responseId: "response", detail: "raw live text", frame: true })])}\n`
		const original = { ...recording, gzip: gzipSync(traceCast).toString("base64") }
		const html = await addTerminalReplay(`<body>${transcript}</body>`, [original])
		expect(html).toContain(transcript)
		const encoded = html.match(/id="terminal-replay-document" type="application\/json">([^<]+)/)?.[1]
		if (!encoded) throw new Error("Replay document missing")
		const player = JSON.parse(encoded)
		const payload = player.match(/id="recordings" type="application\/json">([^<]+)/)?.[1]
		if (!payload) throw new Error("Replay payload missing")
		const [embedded] = JSON.parse(payload)
		expect(embedded).not.toHaveProperty("traceDetails")
		const details = JSON.parse(gunzipSync(Buffer.from(embedded.traceDetailsGzip, "base64")).toString("utf8"))
		expect(details["1"].content).toBe(savedText)
		expect(embedded.gzip).toBe(original.gzip)
		expect(player).not.toContain(savedText)
		expect(original).not.toHaveProperty("traceDetails")
	})
})
