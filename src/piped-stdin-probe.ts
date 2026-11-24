/**
 * pi reads piped stdin itself and runs a leading `/command` before any
 * extension event fires, so watching the emitted data is the only way to learn
 * that stdin carried a prompt. Wrapping `emit` (like the paste interceptor)
 * does not switch the stream into flowing mode, so pi still gets every chunk.
 */
export interface PipedStdinProbe {
	hasText(): boolean
}

export function watchPipedStdinText(stdin: NodeJS.ReadStream = process.stdin): PipedStdinProbe {
	let sawText = false
	if (stdin.isTTY) return { hasText: () => false }
	const originalEmit = stdin.emit.bind(stdin)
	stdin.emit = (event: string | symbol, ...args: unknown[]) => {
		if (!sawText && event === "data") {
			const chunk = args[0]
			const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : ""
			// pi trims stdin and ignores it when only whitespace is left.
			if (text.trim().length > 0) sawText = true
		}
		return originalEmit(event, ...args)
	}
	return { hasText: () => sawText }
}
