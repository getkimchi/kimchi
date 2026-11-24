import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { watchPipedStdinText } from "./piped-stdin-probe.js"

function fakeStdin(isTTY: boolean): NodeJS.ReadStream {
	const stream = new PassThrough()
	return Object.assign(stream, { isTTY }) as unknown as NodeJS.ReadStream
}

async function readAll(stdin: NodeJS.ReadStream): Promise<string> {
	let data = ""
	stdin.setEncoding("utf8")
	stdin.on("data", (chunk: string) => {
		data += chunk
	})
	await new Promise((resolve) => stdin.on("end", resolve))
	return data
}

describe("watchPipedStdinText", () => {
	it("reports text and still passes every chunk to the reader", async () => {
		const stdin = fakeStdin(false)
		const probe = watchPipedStdinText(stdin)
		const reading = readAll(stdin)
		stdin.push("  \n")
		stdin.push("/language")
		stdin.push(null)
		expect(await reading).toBe("  \n/language")
		expect(probe.hasText()).toBe(true)
	})

	it("ignores whitespace-only stdin, as pi does", async () => {
		const stdin = fakeStdin(false)
		const probe = watchPipedStdinText(stdin)
		const reading = readAll(stdin)
		stdin.push(" \n\t")
		stdin.push(null)
		await reading
		expect(probe.hasText()).toBe(false)
	})

	it("reports no text for empty stdin", async () => {
		const stdin = fakeStdin(false)
		const probe = watchPipedStdinText(stdin)
		const reading = readAll(stdin)
		stdin.push(null)
		await reading
		expect(probe.hasText()).toBe(false)
	})

	it("does not wrap a TTY", () => {
		const stdin = fakeStdin(true)
		const emit = stdin.emit
		const probe = watchPipedStdinText(stdin)
		expect(stdin.emit).toBe(emit)
		expect(probe.hasText()).toBe(false)
	})
})
