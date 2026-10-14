import { appendFile, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type Recording, readRecordings, recordingDeadline, TerminalRecorder } from "./recorder.js"

function cast(recording: Recording): string {
	return gunzipSync(Buffer.from(recording.gzip, "base64")).toString("utf8")
}

const roots: string[] = []
const beginFrame = "\x1b[?2026h"
const endFrame = "\x1b[?2026l"
const failedStep = {
	kind: "tool_result" as const,
	title: "bash failed",
	detail: "exit 1",
	error: true,
	toolCallId: "call-1",
}

function events(recording: Recording): [number, string, string][] {
	return cast(recording)
		.trim()
		.split("\n")
		.slice(1)
		.map((line) => JSON.parse(line))
}

function markers(recording: Recording) {
	return events(recording)
		.filter((event) => event[1] === "m")
		.map((event) => JSON.parse(event[2]))
}

async function root() {
	const path = await mkdtemp(join(tmpdir(), "kimchi-recording-"))
	roots.push(path)
	return path
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("terminal recording", () => {
	it("does no work over five idle days and preserves the next event's full elapsed time", async () => {
		const directory = await root()
		let now = 0
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "idle-days",
			cols: 80,
			rows: 24,
			now: () => now,
		})
		const output = join(recorder.directory, "output.bin")
		const metadata = join(recorder.directory, "metadata.json")
		const before = await Promise.all([stat(output, { bigint: true }), stat(metadata, { bigint: true })])
		const flush = vi.spyOn(recorder, "flush")
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		try {
			const fiveDays = 5 * 24 * 60 * 60 * 1000
			now = fiveDays
			await vi.advanceTimersByTimeAsync(fiveDays)
			expect(flush).not.toHaveBeenCalled()
			expect(vi.getTimerCount()).toBe(0)
			const after = await Promise.all([stat(output, { bigint: true }), stat(metadata, { bigint: true })])
			expect(after.map(({ size, mtimeNs }) => ({ size, mtimeNs }))).toEqual(
				before.map(({ size, mtimeNs }) => ({ size, mtimeNs })),
			)
			recorder.write("after five days")
			await recorder.flush()
			expect(events((await readRecordings(directory, "idle-days"))[0])).toEqual([[432000, "o", "after five days"]])
			now += 1000
			await recorder.close()
			const [recording] = await readRecordings(directory, "idle-days")
			expect(events(recording)).toEqual([
				[432000, "o", "after five days"],
				[1, "o", ""],
			])
			expect(recording.metadata).toMatchObject({ status: "complete", duration: 432001 })
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
			await recorder.close()
		}
	})

	it("does not rewrite active metadata for repeated empty flushes", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({ root: directory, sessionId: "empty-flush", cols: 80, rows: 24 })
		try {
			const metadata = join(recorder.directory, "metadata.json")
			await utimes(metadata, new Date(0), new Date(0))
			const before = await stat(metadata, { bigint: true })
			await Promise.all([recorder.flush(), recorder.flush(), recorder.flush()])
			const after = await stat(metadata, { bigint: true })
			expect(after.mtimeNs).toBe(before.mtimeNs)
			expect(after.ino).toBe(before.ino)
			expect(recorder.metadata.chunks).toBe(1)
		} finally {
			await recorder.close()
		}
	})

	it("awaits an in-flight append when an empty flush is requested", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({ root: directory, sessionId: "waiting-flush", cols: 80, rows: 24 })
		try {
			recorder.write("pending append")
			let persisted = false
			const first = recorder.flush().then(() => {
				persisted = true
			})
			await recorder.flush()
			expect(persisted).toBe(true)
			await first
			expect(events((await readRecordings(directory, "waiting-flush"))[0]).map((event) => event[2])).toEqual([
				"pending append",
			])
		} finally {
			await recorder.close()
		}
	})

	it("publishes a limit state even when the rejected write leaves no pending bytes", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "empty-limit",
			cols: 80,
			rows: 24,
			limits: { rawBytes: 512 },
		})
		recorder.write("x".repeat(1024))
		await recorder.flush()
		expect(JSON.parse(await readFile(join(recorder.directory, "metadata.json"), "utf8"))).toMatchObject({
			status: "size-limit",
			chunks: 1,
		})
		await recorder.close()
	})

	it("batches low-volume output for one second and flushes export and close immediately", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({ root: directory, sessionId: "flush-time", cols: 80, rows: 24 })
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const flush = vi.spyOn(recorder, "flush")
		try {
			recorder.write("first")
			await vi.advanceTimersByTimeAsync(999)
			expect(flush).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(1)
			expect(flush).toHaveBeenCalledTimes(1)
			await flush.mock.results[0].value
			expect(events((await readRecordings(directory, "flush-time"))[0]).map((event) => event[2])).toEqual(["first"])
			recorder.write("export")
			await recorder.flush()
			expect(events((await readRecordings(directory, "flush-time"))[0]).map((event) => event[2])).toEqual([
				"first",
				"export",
			])
			recorder.write("close")
			await recorder.close()
			expect(events((await readRecordings(directory, "flush-time"))[0]).map((event) => event[2])).toEqual([
				"first",
				"export",
				"close",
				"",
			])
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
			await recorder.close()
		}
	})

	it("flushes high-volume output at 256 KiB without waiting for the timer", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({ root: directory, sessionId: "flush-size", cols: 80, rows: 24 })
		const flush = vi.spyOn(recorder, "flush")
		recorder.write("x".repeat(128 * 1024))
		expect(flush).not.toHaveBeenCalled()
		recorder.write("y".repeat(128 * 1024))
		expect(flush).toHaveBeenCalledTimes(1)
		await flush.mock.results[0].value
		expect(events((await readRecordings(directory, "flush-size"))[0]).map((event) => event[2])).toEqual([
			"x".repeat(128 * 1024),
			"y".repeat(128 * 1024),
		])
		await recorder.close()
	})

	it("preserves Unicode, escapes, resize order and exact accounting across automatic batches", async () => {
		const directory = await root()
		let now = 0
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "batch-fidelity",
			cols: 80,
			rows: 24,
			now: () => now,
		})
		const expected: [number, string, string][] = []
		const text = '界👩🏽‍💻❄️é\ud800\x1b[0m"\\\r\n'.repeat(48)
		for (let i = 0; i < 128; i++) {
			now += 1
			recorder.write(text)
			expected.push([0.001, "o", text])
			if (i % 16 === 0) {
				recorder.resize(80 + i, 24)
				expected.push([0, "r", `${80 + i}x24`])
			}
		}
		await recorder.close()
		expected.push([0, "o", ""])
		const [recording] = await readRecordings(directory, "batch-fidelity")
		expect(events(recording)).toEqual(expected)
		expect(recording.metadata.rawBytes).toBe(Buffer.byteLength(cast(recording)))
		expect(recording.metadata.chunks).toBeGreaterThan(2)
		expect(recording.metadata.queueHighWaterBytes).toBeLessThanOrEqual(1024 * 1024)
	})

	it("links a failed step after its complete split frame and final cursor writes, once", async () => {
		const directory = await root()
		let now = 0
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "trace",
			cols: 80,
			rows: 24,
			now: () => now,
		})
		now = 10
		recorder.trace(failedStep)
		now = 25
		recorder.write(`${beginFrame}failure\x1b[?20`)
		recorder.write("26l")
		recorder.write("\x1b[4;9H\x1b[?25h")
		await Promise.resolve()
		recorder.write(`${beginFrame}later${endFrame}`)
		await recorder.close()
		const [recording] = await readRecordings(directory, "trace")
		const output = events(recording)
		const marker = output.findIndex((event) => event[1] === "m")
		expect(output[marker - 1][2]).toBe("\x1b[4;9H\x1b[?25h")
		expect(markers(recording)).toEqual([
			{ type: "kimchi.trace", version: 1, step: 1, ...failedStep, frame: true, delayMs: 15 },
		])
	})

	it("freezes the associated batch before a later step arrives in the same tick", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({ root: directory, sessionId: "race", cols: 80, rows: 24 })
		recorder.trace(failedStep)
		recorder.write(`${beginFrame}first failure${endFrame}`)
		recorder.trace({ kind: "prompt", title: "Prompt", detail: "next prompt" })
		await Promise.resolve()
		await recorder.flush()
		let [recording] = await readRecordings(directory, "race")
		expect(markers(recording)).toHaveLength(1)
		recorder.write(`${beginFrame}next prompt${endFrame}`)
		// Close must drain an associated batch even before its microtask runs.
		await recorder.close()
		;[recording] = await readRecordings(directory, "race")
		expect(markers(recording).map(({ step, frame }) => ({ step, frame }))).toEqual([
			{ step: 1, frame: true },
			{ step: 2, frame: true },
		])
	})

	it("uses the same timestamp for the marker and its observation delay", async () => {
		const directory = await root()
		let now = 0
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "trace-clock",
			cols: 80,
			rows: 24,
			now: () => now++,
		})
		const observedAt = now
		recorder.trace(failedStep)
		recorder.write(`${beginFrame}failure${endFrame}`)
		await recorder.close()
		const [recording] = await readRecordings(directory, "trace-clock")
		let timeMs = 0
		for (const event of events(recording)) {
			timeMs += event[0] * 1000
			if (event[1] === "m") expect(timeMs - JSON.parse(event[2]).delayMs).toBe(observedAt)
		}
	})

	it("keeps later frames and resizes seekable beyond markers when the clock ties", async () => {
		const directory = await root()
		let now = 0
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "tied-frames",
			cols: 80,
			rows: 24,
			now: () => now,
		})
		now = 10
		recorder.trace(failedStep)
		recorder.trace({ kind: "response", title: "Same frame", detail: "First frame" })
		recorder.write(`${beginFrame}FIRST${endFrame}`)
		recorder.write("\x1b[2;3H\x1b[?25h")
		await Promise.resolve()
		recorder.trace({ kind: "prompt", title: "Next step", detail: "Second frame" })
		recorder.write(`${beginFrame}SECOND${endFrame}`)
		await Promise.resolve()
		recorder.resize(40, 12)
		await recorder.close()
		const [recording] = await readRecordings(directory, "tied-frames")
		let timeUs = 0
		const timeline = events(recording).map(([delta, code, data]) => {
			timeUs += Math.round(delta * 1_000_000)
			return { timeUs, code, data }
		})
		const trace = timeline.filter(({ code }) => code === "m")
		expect(trace.map(({ timeUs }) => timeUs)).toEqual([10_000, 10_000, 10_001])
		expect(timeline.find(({ data }) => data.includes("SECOND"))?.timeUs).toBe(10_001)
		expect(timeline.find(({ code }) => code === "r")?.timeUs).toBe(10_002)
		expect(
			timeline
				.filter(({ timeUs }) => timeUs <= trace[0].timeUs)
				.map(({ data }) => data)
				.join(""),
		).not.toContain("SECOND")
		expect(timeline.find(({ data }) => data === "\x1b[2;3H\x1b[?25h")?.timeUs).toBe(10_000)
		expect(recording.metadata.duration).toBe(0.010002)
	})

	it("preserves sub-millisecond observation and frame times", async () => {
		const directory = await root()
		let now = 0
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "precise-clock",
			cols: 80,
			rows: 24,
			now: () => now,
		})
		now = 1.234
		recorder.trace(failedStep)
		now = 1.456
		recorder.write(`${beginFrame}failure${endFrame}`)
		now = 1.457
		recorder.write("\x1b[2;3H")
		now = 1.458
		await Promise.resolve()
		await recorder.close()
		const [recording] = await readRecordings(directory, "precise-clock")
		expect(
			events(recording)
				.slice(0, 3)
				.map(([delta]) => delta),
		).toEqual([0.001456, 0.000001, 0.000001])
		expect(markers(recording)[0].delayMs).toBe(0.224)
	})

	it("preserves elapsed microseconds across rotations without cumulative rounding", async () => {
		const directory = await root()
		let now = 0
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "precise-parts",
			cols: 30,
			rows: 8,
			now: () => now,
			limits: { rawBytes: 1600 },
		})
		for (let index = 1; index <= 8; index++) {
			now = index * 1000 + 0.123
			recorder.trace({ kind: "prompt", title: "Prompt", detail: `Step ${index}` })
			recorder.write(`${beginFrame}\x1b[2J\x1b[Hframe ${index}${"\x1b[0m".repeat(30)}${endFrame}`)
			await Promise.resolve()
			await recorder.flush()
		}
		now = 9000.456
		await recorder.close()
		const recordings = await readRecordings(directory, "precise-parts")
		expect(recordings.length).toBeGreaterThan(1)
		let totalUs = 0
		for (const recording of recordings) {
			const elapsedUs = events(recording).reduce((sum, [delta]) => sum + Math.round(delta * 1_000_000), 0)
			expect(elapsedUs).toBe(Math.round(recording.metadata.duration * 1_000_000))
			totalUs += elapsedUs
		}
		expect(totalUs).toBe(9_000_456)
	})

	it("retains steps across ordinary flush and finalizes missing frames only on export or close", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({ root: directory, sessionId: "no-frame", cols: 80, rows: 24 })
		recorder.trace(failedStep)
		recorder.write("unframed diagnostic")
		await recorder.flush()
		expect(markers((await readRecordings(directory, "no-frame"))[0])).toEqual([])
		recorder.finalizeTrace()
		await recorder.flush()
		expect(markers((await readRecordings(directory, "no-frame"))[0])).toMatchObject([{ step: 1, frame: false }])
		recorder.trace({ kind: "prompt", title: "Prompt", detail: "still recording" })
		await recorder.close()
		expect(markers((await readRecordings(directory, "no-frame"))[0])).toMatchObject([
			{ step: 1, frame: false },
			{ step: 2, frame: false },
		])
	})

	it("does not certify a frame when output capture was rejected", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "lost-frame",
			cols: 80,
			rows: 24,
			limits: { queuedBytes: 1024 },
		})
		recorder.trace(failedStep)
		recorder.write(`${beginFrame}${"x".repeat(1200)}${endFrame}`)
		await recorder.close()
		const [recording] = await readRecordings(directory, "lost-frame")
		expect(recording.metadata.status).toBe("queue-limit")
		expect(markers(recording).some((marker) => marker.frame)).toBe(false)
	})

	it("bounds waiting trace data and truncates oversized details before serialization", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "bounded-trace",
			cols: 80,
			rows: 24,
			limits: { queuedBytes: 1024 },
		})
		for (let index = 0; index < 100; index++) recorder.trace(failedStep)
		await recorder.close()
		expect(recorder.metadata.status).toBe("queue-limit")
		expect(recorder.metadata.queueHighWaterBytes).toBeLessThanOrEqual(1024)
		const large = await TerminalRecorder.create({ root: directory, sessionId: "large-detail", cols: 80, rows: 24 })
		large.trace({ ...failedStep, title: "t".repeat(200), detail: "d".repeat(100_000) })
		large.write(`${beginFrame}failure${endFrame}`)
		await large.close()
		const [marker] = markers((await readRecordings(directory, "large-detail"))[0])
		expect(marker.title.length).toBeLessThanOrEqual(120)
		expect(marker.detail.length).toBeLessThanOrEqual(8192)
		expect(marker.detail).toContain("…")
	})

	it("keeps a marker with the checkpoint when the associated frame fills the previous part", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "trace-parts",
			cols: 30,
			rows: 8,
			limits: { rawBytes: 1400 },
		})
		recorder.write(`${beginFrame}\x1b[2J\x1b[Hfailure${"\x1b[0m".repeat(120)}${endFrame}`)
		await recorder.flush()
		recorder.trace({ ...failedStep, detail: "e".repeat(500) })
		recorder.write(`${beginFrame}\x1b[2;1Hlast frame${endFrame}`)
		await recorder.flush()
		recorder.finalizeTrace()
		await recorder.close()
		const recordings = await readRecordings(directory, "trace-parts")
		expect(recordings.length).toBeGreaterThan(1)
		const owningPart = recordings.find((recording) => markers(recording).length)
		expect(owningPart).toBeDefined()
		if (!owningPart) throw new Error("Trace marker missing")
		expect(cast(owningPart)).toContain("last frame")
		expect(markers(owningPart)).toMatchObject([{ frame: true, toolCallId: "call-1" }])
	})

	it("continues in bounded parts and retains the screen after earlier parts are evicted", async () => {
		const directory = await root()
		let now = 0
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "five-day-session",
			cols: 30,
			rows: 8,
			limits: { slots: 2, rawBytes: 2048 },
			now: () => now,
		})
		recorder.write("\x1b[2J\x1b[H\x1b[2;1HDUPLICATE BUG\x1b[3;1HDUPLICATE BUG\x1b[4;7H界")
		await recorder.flush()
		for (let index = 0; index < 20; index++) {
			now += 6 * 60 * 60 * 1000
			recorder.write(`\x1b[6;1H\x1b[2K${"\x1b[0m".repeat(30)}update ${index}`)
			await recorder.flush()
		}
		await recorder.close()
		const recordings = await readRecordings(directory, "five-day-session")
		expect(recordings).toHaveLength(2)
		expect(cast(recordings[recordings.length - 1])).toContain("update 19")
		expect(recordings.every(({ metadata }) => metadata.rawBytes <= 2048)).toBe(true)
		expect(recordings.at(-1)?.metadata.status).toBe("complete")
		// The later part must retain the defect even when the part that drew it is gone.
		expect(cast(recordings[recordings.length - 1])).toContain("DUPLICATE BUG")
		expect(cast(recordings[recordings.length - 1])).toContain("界")
	})

	it("returns control if a disk operation stalls", async () => {
		const start = performance.now()
		expect(await recordingDeadline(new Promise(() => {}), 10)).toBeUndefined()
		expect(performance.now() - start).toBeLessThan(500)
	})

	it("continues at the compressed cap with resized geometry and relative timing", async () => {
		const directory = await root()
		let now = 0
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "compressed-parts",
			cols: 30,
			rows: 8,
			limits: { compressedBytes: 800 },
			now: () => now,
		})
		recorder.resize(25, 7)
		for (let index = 0; index < 25; index++) {
			now += 1000
			recorder.write(`\x1b[2J\x1b[Hframe ${index}`)
			await recorder.flush()
		}
		await recorder.close()
		const recordings = await readRecordings(directory, "compressed-parts")
		expect(recordings.length).toBeGreaterThan(1)
		for (const [index, recording] of recordings.entries()) {
			expect(recording.metadata.compressedBytes).toBeLessThanOrEqual(800)
			expect(recording.metadata.part).toBe(index + 1)
			const [header, ...events] = cast(recording)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
			expect(events.reduce((sum, event) => sum + event[0], 0)).toBeCloseTo(recording.metadata.duration)
			if (index) expect(header.term).toEqual({ cols: 25, rows: 7 })
		}
		expect(recordings.reduce((sum, recording) => sum + recording.metadata.duration, 0)).toBe(25)
		expect(cast(recordings[recordings.length - 1])).toContain("frame 24")
	})

	it("reads a committed prefix after abrupt termination and ignores an unfinished final write", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({ root: directory, sessionId: "crashed", cols: 80, rows: 24 })
		recorder.write("saved before interruption")
		await recorder.flush()
		await appendFile(join(recorder.directory, "output.bin"), Buffer.from([0, 0, 255, 255, 31, 139]))
		const [recording] = await readRecordings(directory, "crashed")
		expect(cast(recording)).toContain("saved before interruption")
		expect(recording.metadata.status).toBe("recording")
		await recorder.close()
	})

	it("enforces the compressed cap without skipping a middle chunk", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "compressed",
			cols: 80,
			rows: 24,
			limits: { compressedBytes: 180 },
		})
		recorder.write("small prefix")
		await recorder.flush()
		recorder.write(Array.from({ length: 300 }, (_, i) => String.fromCharCode(32 + (i % 95))).join(""))
		await recorder.flush()
		recorder.write("later frame")
		await recorder.close()
		const [recording] = await readRecordings(directory, "compressed")
		expect(cast(recording)).toContain("small prefix")
		expect(cast(recording)).not.toContain("later frame")
		expect(recording.metadata.status).toBe("size-limit")
		expect((await stat(join(recorder.directory, "output.bin"))).size).toBeLessThanOrEqual(180)
	})

	it("excludes and prunes expired closed visits", async () => {
		const directory = await root()
		const first = await TerminalRecorder.create({ root: directory, sessionId: "expired", cols: 80, rows: 24 })
		await first.close()
		const path = join(first.directory, "metadata.json")
		const metadata = JSON.parse(await readFile(path, "utf8"))
		metadata.startedAt = "2000-01-01T00:00:00Z"
		await writeFile(path, JSON.stringify(metadata))
		expect(await readRecordings(directory, "expired")).toEqual([])
		const second = await TerminalRecorder.create({ root: directory, sessionId: "fresh", cols: 80, rows: 24 })
		await second.close()
		await expect(readFile(path, "utf8")).rejects.toThrow()
	})
	it("preserves output, relative timing and geometry through a persisted recording", async () => {
		const directory = await root()
		let now = 0
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "session-a",
			cols: 120,
			rows: 40,
			now: () => now,
		})
		now = 120
		recorder.write("\x1b[2J\x1b[Hvisible defect: duplicated row\r\n")
		now = 2120
		recorder.resize(80, 24)
		now = 2500
		recorder.write("\x1b[3;7H❄️ 界\x1b[K")
		await recorder.close()
		const [recording] = await readRecordings(directory, "session-a")
		const [header, ...events] = cast(recording)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		expect(header).toMatchObject({ version: 3, term: { cols: 120, rows: 40 } })
		expect(events.slice(0, 3)).toEqual([
			[0.12, "o", "\x1b[2J\x1b[Hvisible defect: duplicated row\r\n"],
			[2, "r", "80x24"],
			[0.38, "o", "\x1b[3;7H❄️ 界\x1b[K"],
		])
		expect(recording.metadata.status).toBe("complete")
		expect(await readRecordings(directory, "other-session")).toEqual([])
		expect((await stat(recorder.directory)).mode & 0o777).toBe(0o700)
	})

	it("keeps a playable prefix and records the reason when a size cap is hit", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "capped",
			cols: 80,
			rows: 24,
			limits: { rawBytes: 512 },
		})
		recorder.write("first frame")
		recorder.write("X".repeat(1000))
		recorder.write("must not appear")
		await recorder.close()
		const [recording] = await readRecordings(directory, "capped")
		expect(cast(recording)).toContain("first frame")
		expect(cast(recording)).not.toContain("must not appear")
		expect(recording.metadata.status).toBe("size-limit")
		expect(recording.metadata.rawBytes).toBeLessThanOrEqual(512)
	})

	it("stops on queue pressure instead of retaining unbounded output", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({
			root: directory,
			sessionId: "busy",
			cols: 80,
			rows: 24,
			limits: { queuedBytes: 1024 },
		})
		for (let i = 0; i < 100; i++) recorder.write("redraw ".repeat(70))
		await recorder.close()
		const [recording] = await readRecordings(directory, "busy")
		expect(recording.metadata.status).toBe("queue-limit")
		expect(recording.metadata.queueHighWaterBytes).toBeLessThanOrEqual(1024)
	})

	it("bounds retained visits and replaces only an inactive slot", async () => {
		const directory = await root()
		const options = { root: directory, cols: 80, rows: 24, limits: { slots: 1 } }
		const first = await TerminalRecorder.create({ ...options, sessionId: "first" })
		first.write("old")
		await first.flush()
		await expect(TerminalRecorder.create({ ...options, sessionId: "second" })).rejects.toThrow("in use")
		await first.close()
		const second = await TerminalRecorder.create({ ...options, sessionId: "second" })
		second.write("new")
		await second.close()
		expect(await readRecordings(directory, "first")).toEqual([])
		expect(cast((await readRecordings(directory, "second"))[0])).toContain("new")
		expect((await readdir(directory)).filter((name) => name.startsWith("slot-"))).toHaveLength(1)
	})

	it("keeps the TUI write path usable after a storage failure", async () => {
		const directory = await root()
		const recorder = await TerminalRecorder.create({ root: directory, sessionId: "failed", cols: 80, rows: 24 })
		await rm(recorder.directory, { recursive: true })
		expect(() => recorder.write("output still works")).not.toThrow()
		await expect(recorder.flush()).resolves.toBeUndefined()
		expect(recorder.metadata.status).toBe("storage-error")
		await recorder.close()
	})
})
