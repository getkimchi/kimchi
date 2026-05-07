import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent"

export interface MaxIterationsOptions {
	maxIterations: number // must be >= 1
	onLimit?: () => void // called when limit hit, default ctx.shutdown()
}

export function maxIterationsExtension(options: MaxIterationsOptions): (pi: ExtensionAPI) => void {
	if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1) {
		throw new Error("maxIterations must be a positive integer")
	}
	return (pi) => {
		let count = 0
		let triggered = false
		pi.on("turn_end", (_event: TurnEndEvent, ctx: ExtensionContext) => {
			if (triggered) return
			count++
			if (count >= options.maxIterations) {
				triggered = true
				process.stderr.write(`max-iterations: hit limit ${options.maxIterations}, shutting down\n`)
				if (options.onLimit) {
					options.onLimit()
					return
				}
				try {
					ctx.shutdown()
				} catch {
					// ignore — we're exiting anyway
				}
				process.exit(0)
			}
		})
	}
}
