import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
	configureReviewPrintStream,
	emitReviewAgentSettled,
	emitReviewChildUsage,
	flushReviewPrintEvents,
	startReviewPrintTermination,
} from "../../../src/extensions/review-command/stream.js"

interface HostOutputGuard {
	writeRawStdout(text: string): void
	flushRawStdout(): Promise<void>
}

async function main(): Promise<void> {
	const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))
	const guardUrl = pathToFileURL(join(dirname(packageEntry), "core", "output-guard.js")).href
	const guard = (await import(guardUrl)) as HostOutputGuard
	guard.writeRawStdout(`${JSON.stringify({ type: "session", payload: "x".repeat(32 * 1024 * 1024) })}\n`)
	await configureReviewPrintStream(true)

	if (process.argv[2] === "ordered") {
		emitReviewChildUsage({
			writer: "spec",
			provider: "fake",
			model: "basic",
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		})
		emitReviewAgentSettled()
		await flushReviewPrintEvents()
		await guard.flushRawStdout()
		return
	}

	emitReviewChildUsage({
		writer: "spec",
		provider: "fake",
		model: "basic",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	})
	startReviewPrintTermination({
		deadlineMs: Date.now(),
		graceMs: 100,
		exitMarginMs: 0,
		abort: () => {},
	})
	setInterval(() => {}, 1_000)
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
