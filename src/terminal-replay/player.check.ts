/** Manual browser regression: pnpm exec tsx src/terminal-replay/player.check.ts */
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { gzipSync } from "node:zlib"
import { chromium, type Locator } from "playwright"
import { postProcessHtmlExport } from "../utils/export-post-process.js"
import { addTerminalReplay } from "./export.js"
import { readRecordings, TerminalRecorder } from "./recorder.js"

const directory = await mkdtemp(join(tmpdir(), "kimchi-replay-browser-"))
const browser = await chromium.launch({
	channel: process.env.REPLAY_BROWSER_CHANNEL,
	headless: process.env.REPLAY_BROWSER_HEADED !== "1",
})
try {
	let now = 0
	const recorder = await TerminalRecorder.create({
		root: directory,
		sessionId: "visual-defect",
		cols: 80,
		rows: 24,
		now: () => now,
	})
	now = 100
	recorder.write("\x1b[2J\x1b[H\x1b[2;1HDUPLICATE BUG\x1b[3;1HDUPLICATE BUG\x1b[4;7H界 e\u0301\x1b[5;77H🧑ABZ")
	now = 2000
	recorder.write("\x1b[3;1H\x1b[2Kcleared later")
	now = 3000
	recorder.resize(40, 12)
	recorder.write("\x1b[2J\x1b[H\x1b[4;39HXYZZ\x1b[?25l")
	now = 5000
	await recorder.close()
	const second = await TerminalRecorder.create({
		root: directory,
		sessionId: "visual-defect",
		cols: 20,
		rows: 6,
		now: () => now,
	})
	now = 5500
	second.write("\x1b[2J\x1b[HSECOND VISIT")
	now = 10000
	await second.close()
	const recordings = await readRecordings(directory, "visual-defect")
	const path = join(directory, "replay.html")
	const transcript = `<!doctype html><html><head><style>body{margin:0}#app{min-height:2400px}</style></head><body><div id="app"><main id="content"><div id="messages">Transcript remains available</div></main></div></body></html>`
	await writeFile(path, await addTerminalReplay(transcript, recordings))
	const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
	await page.context().setOffline(true)
	await page.addInitScript(() => {
		const state = { decompressions: 0 }
		Object.assign(window, { replayCheck: state })
		window.DecompressionStream = new Proxy(window.DecompressionStream, {
			construct(target, args) {
				state.decompressions++
				return Reflect.construct(target, args)
			},
		})
	})
	const requests: string[] = []
	const errors: string[] = []
	page.on("request", (request) => {
		if (/^https?:/.test(request.url())) requests.push(request.url())
	})
	page.on("pageerror", (error) => errors.push(error.message))
	await page.goto(pathToFileURL(path).href)
	assert.equal(await page.locator("#terminal-replay-close").getAttribute("aria-pressed"), "true")
	await page.evaluate(() => window.scrollTo(0, 900))
	await page.locator("#terminal-replay-open").click()
	assert.equal(await page.locator("#app").isVisible(), false)
	assert.equal(await page.locator("#terminal-replay-open").getAttribute("aria-pressed"), "true")
	const frame = page.frameLocator("#terminal-replay-frame")
	await frame.locator(".xterm-screen").waitFor()
	const decompressions = () =>
		frame
			.locator("body")
			.evaluate(() => (window as unknown as { replayCheck: { decompressions: number } }).replayCheck.decompressions)
	assert.equal(await decompressions(), 1, "Opening replay must decode only the selected part")
	assert.equal(
		await frame.locator("body").evaluate(() => {
			try {
				return Boolean(parent.document.body)
			} catch {
				return false
			}
		}),
		false,
		"The replay iframe must not access the transcript document",
	)
	assert.doesNotMatch(await frame.locator("body").innerText(), /Player credits/)
	assert.match(await frame.locator("html").innerHTML(), /Permission is hereby granted, free of charge/)
	const details = frame.locator("details").filter({ has: frame.getByText("Recording details", { exact: true }) })
	assert.equal(await details.locator(".details-body").isVisible(), false)
	await details.locator("summary").click()
	assert.equal(await details.getByText(/Includes visible drafts and cleared text/).isVisible(), true)
	await details.locator("summary").click()
	await frame.getByLabel("Recording part").selectOption("0")
	await frame.locator('#player[aria-busy="false"]').waitFor()
	assert.equal(await frame.locator("#playback-controls").isVisible(), true)
	assert.equal(await frame.getByRole("button", { name: "Play", exact: true }).count(), 1)
	assert.equal(await frame.getByRole("slider", { name: "Seek recording" }).count(), 1)
	async function seek(fraction: number) {
		const slider = frame.getByRole("slider", { name: "Seek recording" })
		const box = await slider.boundingBox()
		assert(box)
		await slider.click({ position: { x: box.width * fraction, y: box.height / 2 } })
		await page.waitForTimeout(150)
	}
	const terminalLines = async (rows: Locator) =>
		(await rows.allTextContents()).map((line) => line.replaceAll("\u00a0", " "))
	const lines = () => terminalLines(frame.locator(".xterm-rows > div"))
	await seek(0.2)
	let rows = await lines()
	assert.equal(rows.length, 24)
	assert.equal(rows[1].trimEnd(), "DUPLICATE BUG")
	assert.equal(rows[2].trimEnd(), "DUPLICATE BUG")
	assert.equal(rows[3].indexOf("界"), 6)
	assert.equal(rows[3].trimEnd(), "      界 e\u0301")
	assert.equal(rows[4].trimEnd(), `${" ".repeat(76)}🧑AB`)
	assert.equal(rows[5].trimEnd(), "Z", "The emoji must occupy two columns before wrapping")
	await seek(0.5)
	assert.equal((await lines())[2].trimEnd(), "cleared later")
	await seek(0.7)
	rows = await lines()
	assert.equal(rows.length, 12, "The recorded resize must change the emulator's rows")
	assert.equal(rows[3].slice(38), "XY")
	assert.equal(rows[4].trimEnd(), "ZZ", "Output must wrap at the recorded width")
	for (let reset = 0; reset < 3; reset++) {
		await seek(0.2)
		rows = await lines()
		assert.equal(rows.length, 24, "Backward seek must restore the initial terminal dimensions")
		assert.equal(rows[3].trimEnd(), "      界 e\u0301")
		assert.equal(rows[4].trimEnd(), `${" ".repeat(76)}🧑AB`)
		assert.equal(rows[5].trimEnd(), "Z", "Repeated resets must retain Unicode character widths")
		await seek(0.7)
		assert.equal((await lines())[4].trimEnd(), "ZZ")
	}
	await frame.getByLabel("Seek recording").evaluate((element) => {
		const slider = element as HTMLInputElement
		for (const fraction of [0.2, 0.7, 0.2]) {
			slider.value = String(Number(slider.max) * fraction)
			slider.dispatchEvent(new Event("input", { bubbles: true }))
		}
	})
	await frame.locator(".xterm-rows > div").filter({ hasText: "🧑AB" }).waitFor()
	await page.waitForTimeout(150)
	rows = await lines()
	assert.equal(rows.length, 24, "The last request in a rapid seek sequence must win")
	assert.equal(rows[5].trimEnd(), "Z")
	await seek(0.7)
	const screenBeforeSpeed = await frame.locator(".xterm-screen").elementHandle()
	assert(screenBeforeSpeed)
	await frame.getByLabel("Playback speed").selectOption("4")
	await page.waitForTimeout(200)
	assert.equal(
		await screenBeforeSpeed.evaluate((element) => element.isConnected),
		true,
		"Changing speed must keep the visible terminal mounted",
	)
	assert.equal((await lines())[4].trimEnd(), "ZZ", "Speed change must preserve position")
	await frame.getByRole("button", { name: "Play", exact: true }).click()
	await page.waitForTimeout(100)
	await frame.getByRole("button", { name: "Pause", exact: true }).click()
	await seek(0.2)
	await frame.getByRole("button", { name: "Play", exact: true }).click()
	await frame.getByLabel("Playback speed").selectOption("0.5")
	await page.waitForTimeout(200)
	assert.equal(await screenBeforeSpeed.evaluate((element) => element.isConnected), true)
	await screenBeforeSpeed.dispose()
	assert.equal(
		await frame.getByRole("button", { name: "Pause", exact: true }).isVisible(),
		true,
		"Changing speed while playing must continue playback",
	)
	await frame.getByRole("button", { name: "Pause", exact: true }).click()
	await seek(0.7)
	const beforeClose = await lines()
	await page.locator("#terminal-replay-close").click()
	assert.equal(await page.locator("#terminal-replay-panel").isVisible(), false)
	assert.equal(await page.locator("#app").isVisible(), true)
	assert.equal(await page.evaluate(() => window.scrollY), 900, "Returning must preserve transcript scroll")
	await page.locator("#terminal-replay-open").click()
	await frame.locator(".xterm-screen").waitFor()
	assert.deepEqual(await lines(), beforeClose, "Reopening replay must preserve the recorded screen and position")
	assert.equal(await frame.getByLabel("Playback speed").inputValue(), "0.5")
	await frame.getByRole("button", { name: "Play", exact: true }).click()
	await page.locator("#terminal-replay-close").focus()
	await page.keyboard.press("Escape")
	await page.waitForTimeout(100)
	const whileClosed = await lines()
	await page.waitForTimeout(300)
	await page.locator("#terminal-replay-open").click()
	assert.deepEqual(await lines(), whileClosed, "Playback must pause while the transcript is visible")
	assert.equal(await frame.getByRole("button", { name: "Play", exact: true }).isVisible(), true)
	await frame.getByLabel("Recording part").selectOption("1")
	await frame.locator('#player[aria-busy="false"]').waitFor()
	await seek(0.5)
	rows = await lines()
	assert.equal(rows.length, 6)
	assert.equal(rows[0].trimEnd(), "SECOND VISIT", "Switching visits must replace the cached recording")
	await frame.getByLabel("Recording part").selectOption("0")
	await frame.locator('#player[aria-busy="false"]').waitFor()
	await seek(0.7)
	assert.equal((await lines())[4].trimEnd(), "ZZ")
	assert.equal(await frame.locator("#player .xterm").count(), 1, "Only the selected player remains mounted")
	const downloaded = page.waitForEvent("download")
	await frame.getByRole("button", { name: "Download part", exact: true }).click()
	const download = await downloaded
	assert.match(download.suggestedFilename(), /^kimchi-replay-.*-part-1\.html$/)
	const downloadPath = join(directory, download.suggestedFilename())
	await download.saveAs(downloadPath)
	const downloadedHtml = await readFile(downloadPath, "utf8")
	const payload = downloadedHtml.match(/<script id="recordings" type="application\/json">(.*?)<\/script>/s)
	assert(payload)
	assert.deepEqual(JSON.parse(payload[1]), [recordings[0]], "Download must contain only the selected part")
	const offline = await browser.newPage()
	await offline.context().setOffline(true)
	offline.on("pageerror", (error) => errors.push(error.message))
	await offline.goto(pathToFileURL(downloadPath).href)
	await offline.locator('#player[aria-busy="false"]').waitFor()
	assert.equal(await offline.getByLabel("Recording part").locator("option").count(), 1)
	assert.match(await offline.content(), /Permission is hereby granted, free of charge/)
	await offline.getByRole("button", { name: "Play", exact: true }).click()
	await offline.waitForTimeout(300)
	assert.equal((await terminalLines(offline.locator(".xterm-rows > div")))[1].trimEnd(), "DUPLICATE BUG")
	await offline.close()
	await page.setViewportSize({ width: 390, height: 844 })
	await page.waitForTimeout(150)
	await details.locator("summary").click()
	const detailsBox = await details.locator(".details-body").boundingBox()
	assert(detailsBox && detailsBox.x >= 0 && detailsBox.x + detailsBox.width <= 390)
	await details.locator("summary").click()
	const controls = await frame.locator("#playback-controls").boundingBox()
	assert(controls && controls.x >= 0 && controls.x + controls.width <= 390 && controls.y + controls.height <= 844)
	await page.locator("#terminal-replay-close").click()
	assert.equal(await page.locator("#app").isVisible(), true)

	const rolling = await TerminalRecorder.create({
		root: join(directory, "rolling"),
		sessionId: "rolling",
		cols: 30,
		rows: 8,
		limits: { slots: 2, rawBytes: 2048 },
		now: () => now,
	})
	rolling.write("\x1b[2J\x1b[H\x1b[2;1H\x1b[31mDUPLICATE BUG\x1b[3;1HDUPLICATE BUG\x1b[4;7H界\x1b[0m")
	rolling.resize(25, 7)
	await rolling.flush()
	for (let index = 0; index < 20; index++) {
		now += 1000
		rolling.write(`\x1b[6;1H\x1b[2K${"\x1b[0m".repeat(30)}update ${index}`)
		await rolling.flush()
	}
	await rolling.close()
	const retained = await readRecordings(join(directory, "rolling"), "rolling")
	assert.equal(retained.length, 2)
	assert((retained[0].metadata.part ?? 1) > 1, "The original part must have been evicted")
	await writeFile(path, await addTerminalReplay(transcript, retained))
	await page.goto(pathToFileURL(path).href)
	await page.locator("#terminal-replay-open").click()
	await frame.locator('#player[aria-busy="false"]').waitFor()
	await seek(0.9)
	rows = await lines()
	assert.equal(rows.length, 7)
	assert.equal(rows[1].trimEnd(), "DUPLICATE BUG", "A later part must retain an earlier visual defect")
	assert.equal(rows[2].trimEnd(), "DUPLICATE BUG")
	assert.equal(rows[3].indexOf("界"), 6)
	assert.match(rows[5], /update 1\d/)

	const inlineTranscript = transcript.replace(
		'<div id="messages">',
		'<div id="header-container"><div class="help-actions" style="display:flex;gap:8px"><button class="download-json-btn">↓ JSONL</button></div></div><div id="messages">',
	)
	await writeFile(path, await addTerminalReplay(inlineTranscript, recordings))
	await page.goto(pathToFileURL(path).href)
	assert.equal(await page.locator(".help-actions #terminal-replay-open").count(), 1)
	assert.equal(await page.locator("#terminal-replay-toolbar").isVisible(), false)
	await page.locator("#terminal-replay-open").click()
	await frame.locator('#player[aria-busy="false"]').waitFor()
	await page.locator("#terminal-replay-close").click()
	assert.equal(await page.locator(".help-actions #terminal-replay-open").isVisible(), true)
	assert.equal(await page.evaluate(() => document.activeElement?.id), "terminal-replay-open")
	await page.locator("#header-container").evaluate((element) => {
		element.innerHTML = '<div class="help-actions"><button class="download-json-btn">↓ JSONL</button></div>'
	})
	await page.locator(".help-actions #terminal-replay-open").waitFor()
	assert.equal(await page.locator("#terminal-replay-open").count(), 1, "Header rerenders must not duplicate buttons")

	// Exercise the actual subagent clone/switcher with a small export shell.
	const subagentData = Buffer.from(
		JSON.stringify({
			entries: [
				{
					type: "custom",
					customType: "subagents:record",
					data: {
						id: "agent-001",
						type: "Explore",
						status: "completed",
						transcript: [
							{
								isSidechain: true,
								agentId: "agent-001",
								type: "user",
								message: { role: "user", content: "Subagent transcript" },
								timestamp: "2026-10-13T10:00:00Z",
								cwd: directory,
							},
						],
					},
				},
			],
		}),
	).toString("base64")
	await writeFile(
		path,
		transcript.replace("</body>", `<script id="session-data" type="application/json">${subagentData}</script></body>`),
	)
	postProcessHtmlExport(path)
	await writeFile(path, await addTerminalReplay(await readFile(path, "utf8"), recordings))
	await page.goto(pathToFileURL(path).href)
	await page.locator('[data-sa-id="agent-001"]').click()
	const subagent = page.locator("body > iframe")
	await subagent.contentFrame().locator("#app").waitFor()
	assert.equal(await subagent.contentFrame().locator('[id^="terminal-replay-"]').count(), 0)
	await page.locator("#terminal-replay-open").click()
	await frame.locator(".xterm-screen").waitFor()
	assert.equal(await subagent.isVisible(), false)
	assert.equal(await page.locator("#subagent-tabs").isVisible(), false)
	await page.locator("#terminal-replay-close").click()
	assert.equal(await subagent.isVisible(), true, "Returning must preserve the selected subagent")
	await page.locator('[data-sa-id="main"]').click()
	await page.locator("#sa-body").evaluate((element) => {
		element.scrollTop = 700
	})
	await page.locator("#terminal-replay-open").click()
	await page.locator("#terminal-replay-close").click()
	assert.equal(await page.locator("#sa-body").evaluate((element) => element.scrollTop), 700)

	// Known screens and times make trace navigation independent of live model timing.
	const hostileDetail = '</script><img src="https://example.invalid/trace-leak" onerror="window.traceInjected=true">'
	const savedFailedOutput = "FIRST_PART_SAVED_RESULT: the finalized tool output differs from the visible failure"
	const savedResponse =
		"The saved response includes 界 🧑 e\u0301 \u2028\u2029 and more context than the live trace excerpt."
	const responseFields = {
		Model: "part-one-only-model",
		"Input tokens": "128",
		"Output tokens": "24",
		"Stop reason": "stop",
	}
	const responseDiagnostics = JSON.stringify({ status: 503, error: hostileDetail })
	const secondDiagnostics = JSON.stringify({ requestId: "second-part-request", status: 503, error: hostileDetail })
	const marker = (
		step: number,
		kind: string,
		title: string,
		detail: string,
		extra: { error?: boolean; frame?: boolean; toolCallId?: string } = {},
	) =>
		JSON.stringify({ type: "kimchi.trace", version: 1, step, kind, title, detail, frame: true, delayMs: 20, ...extra })
	const tracedPart = (
		part: number,
		events: [number, string, string][],
		traceDetails?: Record<string, { fields: Record<string, string>; content?: string; diagnostics?: string }>,
	) => {
		const header = JSON.stringify({ version: 3, term: { cols: 60, rows: 8 } })
		const cast = `${header}\n${events.map((event) => JSON.stringify(event)).join("\n")}\n`
		const gzip = gzipSync(cast)
		return {
			gzip: gzip.toString("base64"),
			traceDetails,
			metadata: {
				...recordings[0].metadata,
				id: `trace-part-${part}`,
				sessionId: "trace-debugging",
				part,
				cols: 60,
				rows: 8,
				duration: events.reduce((total, event) => total + event[0], 0),
				rawBytes: Buffer.byteLength(cast),
				compressedBytes: gzip.length,
			},
		}
	}
	const traced = [
		tracedPart(1, [
			[0.1, "o", "\x1b[2J\x1b[HREQUEST: inspect the demo"],
			[0, "m", marker(1, "prompt", "Inspect the demo", "Read the demo file")],
			[0.4, "o", "\x1b[2J\x1b[HRUNNING: read missing.txt"],
			[0, "m", marker(2, "tool_call", "Read missing.txt", "Path: missing.txt", { toolCallId: "failed-read" })],
			[0.75, "o", "\x1b[2J\x1b[HERROR: missing.txt not found"],
			[
				0,
				"m",
				marker(3, "tool_result", "Read failed", "missing.txt not found", { error: true, toolCallId: "failed-read" }),
			],
			[0, "m", marker(4, "response", "Explain the failure", hostileDetail)],
			[1.25, "o", "\x1b[2J\x1b[HRECOVERED: read existing.txt"],
			[
				0,
				"m",
				marker(5, "tool_result", "Read succeeded", "The existing file was read", { toolCallId: "recovered-read" }),
			],
			[
				1,
				"m",
				marker(6, "error", "Interrupted before redraw", "The terminal did not finish a frame", {
					error: true,
					frame: false,
				}),
			],
			[0.5, "o", ""],
		]),
		tracedPart(2, [
			[0.1, "o", "\x1b[2J\x1b[HCONTINUED: second part"],
			[0, "m", marker(7, "response", "Continue in part two", "This step belongs to the second part")],
			[0.4, "o", "\x1b[2J\x1b[HSECOND ERROR: the next failure"],
			[0, "m", marker(8, "error", "Second failure", "The next operation failed", { error: true })],
			[1.5, "o", ""],
		]),
	]
	traced[0].traceDetails = {
		3: { fields: { Tool: "read", "Saved result": "success" }, content: savedFailedOutput },
		4: { fields: responseFields, content: savedResponse, diagnostics: responseDiagnostics },
	}
	traced[1].traceDetails = {
		8: {
			fields: { Model: "part-two-model", "Stop reason": "error" },
			content: "SECOND_PART_SAVED_RESULT",
			diagnostics: secondDiagnostics,
		},
	}
	await writeFile(path, await addTerminalReplay(transcript, [...traced, recordings[0]]))
	await page.setViewportSize({ width: 1440, height: 1000 })
	await page.goto(pathToFileURL(path).href)
	await page.locator("#terminal-replay-open").click()
	await frame.locator('#player[aria-busy="false"]').waitFor()
	assert.equal(await decompressions(), 1, "Other parts' compressed details must remain undecoded")
	await frame.getByLabel("Recording part").selectOption("0")
	await frame.locator('#player[aria-busy="false"]').waitFor()
	assert.equal(await decompressions(), 3, "Selecting a part must decode its cast and details once")
	assert.equal(await frame.locator("#trace-list .trace-step").count(), 6, "Every linked step must be inspectable")
	assert.equal(await frame.getByLabel("Pause on errors").isChecked(), true)
	const step = (number: number) => frame.locator(`#trace-list .trace-step[data-step="${number}"]`)
	const selected = (number: number) =>
		frame.locator(`#trace-list .trace-step[data-step="${number}"][aria-current="true"]`).waitFor()
	await step(3).click()
	await selected(3)
	assert.equal(
		(await lines())[0].trimEnd(),
		"ERROR: missing.txt not found",
		"Selecting a failure must show its completed frame",
	)
	assert.equal(await frame.getByRole("button", { name: "Play", exact: true }).isVisible(), true)
	assert.match(await frame.locator("#trace-title").innerText(), /Read failed/)
	assert.equal(await frame.locator("#trace-detail").innerText(), "missing.txt not found")
	assert.equal(await frame.locator("#trace-saved").getAttribute("open"), null)
	await frame.locator("#trace-saved summary").click()
	assert.equal(await frame.locator("#trace-content").innerText(), savedFailedOutput)
	assert.match(
		await frame.locator("#trace-extra-state").innerText(),
		/Final content can differ from the captured output/,
	)
	await frame.getByRole("button", { name: "Next step", exact: true }).click()
	await selected(4)
	await page.waitForTimeout(200)
	assert.equal(
		await step(4).getAttribute("aria-current"),
		"true",
		"Equal-time steps must keep the user's selection while paused",
	)
	assert.equal(await frame.locator("#trace-detail").innerText(), hostileDetail)
	assert.equal(await frame.locator("#trace-detail img").count(), 0, "Trace text must not become executable markup")
	assert.equal(await frame.locator("#trace-metadata").getAttribute("open"), null)
	await frame.locator("#trace-metadata summary").click()
	assert.deepEqual(
		await frame
			.locator("#trace-fields")
			.evaluate((element) =>
				Object.fromEntries(
					Array.from(element.querySelectorAll("dt"), (label) => [
						label.textContent,
						label.nextElementSibling?.textContent,
					]),
				),
			),
		responseFields,
	)
	assert.equal(await frame.locator("#trace-content").innerText(), savedResponse)
	assert.equal(await frame.locator("#trace-diagnostics").getAttribute("open"), null)
	await frame.locator("#trace-diagnostics summary").click()
	assert.equal(await frame.locator("#trace-diagnostic-detail").innerText(), responseDiagnostics)
	assert.equal(await frame.locator("#trace-diagnostic-detail img").count(), 0, "Diagnostics must remain literal text")
	await frame.getByRole("button", { name: "Previous step", exact: true }).click()
	await selected(3)
	const failedScreen = await lines()
	await step(6).click()
	assert.match(await frame.locator("#trace-state").innerText(), /No completed frame captured for this step\./)
	assert.deepEqual(await lines(), failedScreen, "An unlinked step must not seek to a misleading frame")
	await step(1).click()
	assert.equal(await frame.locator("#trace-fields").textContent(), "")
	assert.equal(await frame.locator("#trace-content").textContent(), "")
	assert.equal(await frame.locator("#trace-diagnostic-detail").textContent(), "")
	assert.match(await frame.locator("#trace-extra-state").innerText(), /No exact saved-session match/)
	await frame.getByRole("button", { name: "Next error", exact: true }).click()
	await selected(3)
	assert.equal(
		await frame.getByRole("button", { name: "Next error", exact: true }).isEnabled(),
		false,
		"Unframed errors are not seek targets",
	)
	await seek(0.19)
	await selected(2)
	assert.equal(
		(await lines())[0].trimEnd(),
		"RUNNING: read missing.txt",
		"Seeking video must select the matching trace step",
	)
	await seek(0.68)
	await selected(5)
	assert.equal((await lines())[0].trimEnd(), "RECOVERED: read existing.txt")
	await frame.getByLabel("Playback speed").selectOption("4")
	await frame.locator('#player[aria-busy="false"]').waitFor()
	await selected(5)
	assert.equal((await lines())[0].trimEnd(), "RECOVERED: read existing.txt")
	await step(1).click()
	await frame.getByRole("button", { name: "Play", exact: true }).click()
	await selected(3)
	await frame.getByRole("button", { name: "Play", exact: true }).waitFor()
	assert.equal(
		(await lines())[0].trimEnd(),
		"ERROR: missing.txt not found",
		"Auto-pause must include the failed screen, not the previous running state",
	)
	await page.waitForTimeout(250)
	assert.deepEqual(await lines(), failedScreen, "An error breakpoint must remain paused")
	await frame.getByLabel("Playback speed").selectOption("1")
	await frame.locator('#player[aria-busy="false"]').waitFor()
	await selected(3)
	assert.deepEqual(await lines(), failedScreen, "Changing speed at a breakpoint must preserve the failed frame")
	await frame.getByRole("button", { name: "Play", exact: true }).click()
	await frame.locator(".xterm-rows > div").filter({ hasText: "RECOVERED: read existing.txt" }).waitFor()
	await frame.getByRole("button", { name: "Pause", exact: true }).click()
	await seek(0.1)
	await frame.getByRole("button", { name: "Play", exact: true }).click()
	await selected(3)
	await frame.getByRole("button", { name: "Play", exact: true }).waitFor()
	await frame.getByLabel("Pause on errors").uncheck()
	await seek(0.1)
	await frame.getByRole("button", { name: "Play", exact: true }).click()
	await frame.locator(".xterm-rows > div").filter({ hasText: "RECOVERED: read existing.txt" }).waitFor()
	await frame.getByRole("button", { name: "Pause", exact: true }).click()
	await frame.getByLabel("Recording part").selectOption("1")
	await frame.locator('#player[aria-busy="false"]').waitFor()
	assert.equal(await frame.locator("#trace-list .trace-step").count(), 2)
	assert.equal(await step(3).count(), 0, "A different part must not retain the previous trace rows")
	await step(7).click()
	await selected(7)
	assert.equal(await frame.locator("#trace-fields").textContent(), "")
	assert.equal(await frame.locator("#trace-content").textContent(), "")
	assert.equal(await frame.locator("#trace-diagnostic-detail").textContent(), "")
	await step(8).click()
	await selected(8)
	assert.equal((await lines())[0].trimEnd(), "SECOND ERROR: the next failure")
	assert.equal(await frame.locator("#trace-metadata").getAttribute("open"), null)
	assert.equal(await frame.locator("#trace-saved").getAttribute("open"), null)
	assert.equal(await frame.locator("#trace-diagnostics").getAttribute("open"), null)
	const traceDownload = page.waitForEvent("download")
	await frame.getByRole("button", { name: "Download part", exact: true }).click()
	const traceDownloadPath = join(directory, "linked-part.html")
	await (await traceDownload).saveAs(traceDownloadPath)
	const downloadedTraceHtml = await readFile(traceDownloadPath, "utf8")
	const downloadedPayload = downloadedTraceHtml.match(
		/<script id="recordings" type="application\/json">(.*?)<\/script>/s,
	)
	assert(downloadedPayload)
	assert.equal(
		JSON.parse(downloadedPayload[1])[0].traceDetails,
		undefined,
		"Download must keep selected details compressed",
	)
	assert.equal(typeof JSON.parse(downloadedPayload[1])[0].traceDetailsGzip, "string")
	assert.equal(downloadedTraceHtml.includes("part-one-only-model"), false)
	assert.equal(downloadedTraceHtml.includes("FIRST_PART_SAVED_RESULT"), false)
	const linkedOffline = await browser.newPage()
	await linkedOffline.context().setOffline(true)
	linkedOffline.on("pageerror", (error) => errors.push(error.message))
	linkedOffline.on("request", (request) => {
		if (/^https?:/.test(request.url())) requests.push(request.url())
	})
	await linkedOffline.goto(pathToFileURL(traceDownloadPath).href)
	await linkedOffline.locator('#player[aria-busy="false"]').waitFor()
	assert.equal(await linkedOffline.getByLabel("Recording part").locator("option").count(), 1)
	assert.equal(await linkedOffline.locator("#trace-list .trace-step").count(), 2)
	await linkedOffline.locator('#trace-list .trace-step[data-step="8"]').click()
	await linkedOffline.locator('#trace-list .trace-step[data-step="8"][aria-current="true"]').waitFor()
	assert.equal(
		(await terminalLines(linkedOffline.locator(".xterm-rows > div")))[0].trimEnd(),
		"SECOND ERROR: the next failure",
		"Downloaded parts must retain working trace links offline",
	)
	await linkedOffline.locator("#trace-metadata summary").click()
	assert.match(await linkedOffline.locator("#trace-fields").innerText(), /part-two-model/)
	await linkedOffline.locator("#trace-saved summary").click()
	assert.equal(await linkedOffline.locator("#trace-content").innerText(), "SECOND_PART_SAVED_RESULT")
	await linkedOffline.locator("#trace-diagnostics summary").click()
	assert.equal(await linkedOffline.locator("#trace-diagnostic-detail").innerText(), secondDiagnostics)
	assert.equal(await linkedOffline.locator("#trace-diagnostic-detail img").count(), 0)
	const legacyPath = join(directory, "legacy-details.html")
	await writeFile(
		legacyPath,
		downloadedTraceHtml.replace(downloadedPayload[1], () => JSON.stringify([traced[1]]).replaceAll("<", "\\u003c")),
	)
	await linkedOffline.goto(pathToFileURL(legacyPath).href)
	await linkedOffline.locator('#player[aria-busy="false"]').waitFor()
	await linkedOffline.locator('#trace-list .trace-step[data-step="8"]').click()
	await linkedOffline.locator("#trace-saved summary").click()
	assert.equal(
		await linkedOffline.locator("#trace-content").innerText(),
		"SECOND_PART_SAVED_RESULT",
		"Legacy uncompressed details must still display",
	)
	await linkedOffline.close()
	await frame.getByLabel("Recording part").selectOption("2")
	await frame.locator('#player[aria-busy="false"]').waitFor()
	assert.match(await frame.locator("#trace-list").innerText(), /No linked steps in this recording\./)
	for (const name of ["Previous step", "Next step", "Next error"]) {
		assert.equal(await frame.getByRole("button", { name, exact: true }).isEnabled(), false)
	}
	await seek(0.2)
	assert.equal(
		(await lines())[1].trimEnd(),
		"DUPLICATE BUG",
		"Old recordings must continue to play without trace metadata",
	)

	let simultaneousNow = 0
	const simultaneous = await TerminalRecorder.create({
		root: join(directory, "simultaneous"),
		sessionId: "same-clock-frames",
		cols: 60,
		rows: 8,
		now: () => simultaneousNow,
	})
	simultaneous.write("\x1b[2J\x1b[HREADY")
	simultaneousNow = 100
	simultaneous.trace({ kind: "error", title: "First failure", detail: "failed frame", error: true })
	simultaneous.write("\x1b[?2026h\x1b[2J\x1b[HFIRST FAILED FRAME\x1b[?2026l")
	await Promise.resolve()
	simultaneous.trace({ kind: "response", title: "Recovery", detail: "recovered frame" })
	simultaneous.write("\x1b[?2026h\x1b[2J\x1b[HSECOND RECOVERED FRAME\x1b[?2026l")
	await Promise.resolve()
	simultaneousNow = 2000
	await simultaneous.close()
	await writeFile(
		path,
		await addTerminalReplay(transcript, await readRecordings(join(directory, "simultaneous"), "same-clock-frames")),
	)
	await page.goto(pathToFileURL(path).href)
	await page.locator("#terminal-replay-open").click()
	await frame.locator('#player[aria-busy="false"]').waitFor()
	await step(1).click()
	await selected(1)
	assert.equal(
		(await lines())[0].trimEnd(),
		"FIRST FAILED FRAME",
		"Two completed frames from the same clock sample must remain individually seekable",
	)
	await step(2).click()
	await selected(2)
	assert.equal((await lines())[0].trimEnd(), "SECOND RECOVERED FRAME")
	await page.reload()
	await page.locator("#terminal-replay-open").click()
	await frame.locator('#player[aria-busy="false"]').waitFor()
	assert.equal((await lines())[0].trimEnd(), "READY", "Fresh playback must precede both completed frames")
	await frame.getByRole("button", { name: "Play", exact: true }).click()
	await selected(1)
	await frame.getByRole("button", { name: "Play", exact: true }).waitFor()
	assert.equal(
		(await lines())[0].trimEnd(),
		"FIRST FAILED FRAME",
		"Auto-pause must not advance into a same-clock later frame",
	)
	await frame.getByRole("button", { name: "Play", exact: true }).click()
	await frame.locator(".xterm-rows > div").filter({ hasText: "SECOND RECOVERED FRAME" }).waitFor()
	await frame.getByRole("button", { name: "Pause", exact: true }).click()

	const denseEvents: [number, string, string][] = []
	for (let index = 1; index <= 501; index++) {
		denseEvents.push([0.004, "o", `\x1b[2J\x1b[HDENSE STEP ${index}`])
		denseEvents.push([
			0,
			"m",
			marker(index, "tool_result", `Dense step ${index}`, `Result ${index}`, { error: index === 250 }),
		])
	}
	denseEvents.push([1, "o", ""])
	await writeFile(path, await addTerminalReplay(transcript, [tracedPart(1, denseEvents), tracedPart(2, denseEvents)]))
	await page.goto(pathToFileURL(path).href)
	await page.locator("#terminal-replay-open").click()
	await frame.locator('#player[aria-busy="false"]').waitFor()
	assert.equal(await decompressions(), 1, "Other parts' compressed details must remain undecoded")
	await frame.getByLabel("Recording part").selectOption("0")
	await frame.locator('#player[aria-busy="false"]').waitFor()
	assert.equal(await frame.locator("#trace-count").innerText(), "501 in this part")
	assert.equal(await frame.locator("#playback-controls").isVisible(), true)
	assert.equal(await frame.getByRole("button", { name: "Play", exact: true }).count(), 1)
	await frame.locator("#playback-toggle").click()
	await selected(250)
	await frame
		.locator("#playback-toggle")
		.filter({ hasText: /^Play$/ })
		.waitFor()
	assert.equal((await lines())[0].trimEnd(), "DENSE STEP 250", "Dense controls must pause at the failed frame")
	await frame.getByLabel("Playback speed").selectOption("2")
	await frame.locator('#player[aria-busy="false"]').waitFor()
	await selected(250)
	assert.equal((await lines())[0].trimEnd(), "DENSE STEP 250")
	await frame.locator("#playback-toggle").click()
	await frame.locator(".xterm-rows > div").filter({ hasText: "DENSE STEP 501" }).waitFor()
	await frame
		.locator("#playback-toggle")
		.filter({ hasText: /^Play$/ })
		.waitFor()
	await frame.getByLabel("Seek recording").focus()
	await page.keyboard.press("Home")
	await frame.getByRole("button", { name: "Next error", exact: true }).click()
	await selected(250)
	assert.equal((await lines())[0].trimEnd(), "DENSE STEP 250", "Dense seeking must re-enable earlier trace navigation")
	const denseDownload = page.waitForEvent("download")
	await frame.getByRole("button", { name: "Download part", exact: true }).click()
	const densePath = join(directory, "dense-part.html")
	await (await denseDownload).saveAs(densePath)
	const denseOffline = await browser.newPage()
	await denseOffline.context().setOffline(true)
	denseOffline.on("pageerror", (error) => errors.push(error.message))
	await denseOffline.goto(pathToFileURL(densePath).href)
	await denseOffline.locator('#player[aria-busy="false"]').waitFor()
	assert.equal(await denseOffline.locator("#trace-count").innerText(), "501 in this part")
	assert.equal(await denseOffline.getByLabel("Seek recording").isVisible(), true)
	await denseOffline.getByRole("button", { name: "Next error", exact: true }).click()
	await denseOffline.locator('#trace-list .trace-step[data-step="250"][aria-current="true"]').waitFor()
	assert.equal((await terminalLines(denseOffline.locator(".xterm-rows > div")))[0].trimEnd(), "DENSE STEP 250")
	await denseOffline.close()
	await frame.locator("#playback-toggle").click()
	await frame
		.locator("#playback-toggle")
		.filter({ hasText: /^Pause$/ })
		.waitFor()
	await frame.getByLabel("Recording part").selectOption("1")
	await frame.locator('#player[aria-busy="false"]').waitFor()
	assert.equal(
		await frame.locator("#playback-toggle").innerText(),
		"Play",
		"Switching a playing dense part must show its paused state",
	)
	await page.waitForTimeout(150)
	assert.equal(Number(await frame.getByLabel("Seek recording").inputValue()), 0)
	const switchedScreen = await lines()
	await page.waitForTimeout(250)
	assert.equal(Number(await frame.getByLabel("Seek recording").inputValue()), 0)
	assert.deepEqual(await lines(), switchedScreen, "A newly selected dense part must remain paused at the beginning")

	const largeOutput = `\x1b[2J\x1b[HLARGE WRITE START${"\x1b[0m".repeat(600_000)}\x1b[2J\x1b[HSTALE LARGE PART`
	await writeFile(
		path,
		await addTerminalReplay(transcript, [
			tracedPart(1, [
				[0, "o", "\x1b[2J\x1b[HREADY LARGE PART"],
				[0.1, "o", largeOutput],
				[2, "o", ""],
			]),
			tracedPart(2, [
				[0, "o", "\x1b[2J\x1b[HNEW SMALL PART"],
				[2, "o", ""],
			]),
		]),
	)
	await page.goto(pathToFileURL(path).href)
	await page.locator("#terminal-replay-open").click()
	await frame.locator('#player[aria-busy="false"]').waitFor()
	assert.equal(await decompressions(), 1, "Other parts' compressed details must remain undecoded")
	await frame.getByLabel("Recording part").selectOption("0")
	await frame.locator('#player[aria-busy="false"]').waitFor()
	const partSelector = await frame.getByLabel("Recording part").elementHandle()
	assert(partSelector)
	await frame.getByLabel("Seek recording").evaluate((element, selector) => {
		const slider = element as HTMLInputElement
		slider.value = "1"
		slider.dispatchEvent(new Event("input", { bubbles: true }))
		const part = selector as HTMLSelectElement
		part.value = "1"
		part.dispatchEvent(new Event("change", { bubbles: true }))
	}, partSelector)
	await partSelector.dispose()
	await frame.locator('#player[aria-busy="false"]').waitFor()
	await frame.locator(".xterm-rows > div").filter({ hasText: "NEW SMALL PART" }).waitFor()
	await page.waitForTimeout(250)
	assert.equal((await lines())[0].trimEnd(), "NEW SMALL PART", "Queued output from a disposed part must not leak")
	assert.equal(await frame.locator("#player .xterm").count(), 1)
	assert.equal(await frame.getByRole("button", { name: "Play", exact: true }).isVisible(), true)
	assert.equal(Number(await frame.getByLabel("Seek recording").inputValue()), 0)

	await writeFile(
		path,
		await addTerminalReplay(transcript, [
			tracedPart(1, [
				[0, "o", "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25hCURSOR DEMO"],
				[0.1, "o", "\x1b[6 q"],
				[0.4, "o", "\x1b[4 q"],
				[0.4, "o", "\x1b[!p\x1b[HAFTER SOFT RESET"],
				[0.4, "o", "\x1b[6 q"],
				[0.4, "o", "\x1bc\x1b[?1049h\x1b[H\x1b[?25hHARD RESET"],
				[0.3, "o", ""],
			]),
		]),
	)
	await page.goto(pathToFileURL(path).href)
	await page.locator("#terminal-replay-open").click()
	await frame.locator('#player[aria-busy="false"]').waitFor()
	for (const [fraction, shape] of [
		[0.1, "bar"],
		[0.3, "underline"],
		[0.5, "block"],
		[0.7, "bar"],
		[0.9, "block"],
		[0.1, "bar"],
	] as const) {
		await seek(fraction)
		assert.match(
			(await frame.locator(".xterm-cursor").getAttribute("class")) ?? "",
			new RegExp(`xterm-cursor-${shape}\\b`),
			"Recorded cursor shape must survive while the replay controls have focus",
		)
		assert.equal(await frame.locator(".xterm.focus").count(), 0)
		assert.equal(await frame.locator("html").evaluate(() => document.activeElement?.id), "playback-seek")
	}
	await frame.getByLabel("Seek recording").focus()
	await page.keyboard.press("Home")
	await frame.locator(".xterm-cursor-block").waitFor()
	assert.deepEqual(requests, [], "The standalone export must not request remote content")
	assert.deepEqual(errors, [])
	console.log(
		"PASS: terminal fidelity, controls, retained parts, offline download, subagents, linked steps, error breakpoints, legacy recordings and safe trace details",
	)
} finally {
	await browser.close()
	await rm(directory, { recursive: true, force: true })
}
