import {
	getMarkdownTheme,
	getSelectListTheme,
	InteractiveMode,
	type SessionManager,
} from "@earendil-works/pi-coding-agent"
import { stripTerminalSequences } from "@earendil-works/pi-tui"

// Pi owns persistence, quoting and shutdown. It has no resume-hint formatting hook,
// so adapt only its final hint while interactive shutdown is in progress.
interface ShutdownMode {
	isShuttingDown: boolean
	sessionManager: Pick<SessionManager, "getSessionId">
	shutdown(options?: { fromSignal?: boolean }): Promise<void>
}

const installed = new WeakSet<object>()

export function formatResumeHint(output: string, sessionId: string): string {
	const plain = stripTerminalSequences(output)
	const prefix = "To resume this session: "
	const suffix = `--session ${sessionId}\n`
	if (!plain.startsWith(prefix) || !plain.endsWith(suffix)) return output
	const commandPrefix = plain.slice(prefix.length, -suffix.length)
	const heading = getMarkdownTheme().bold("Session saved.")
	const id = getSelectListTheme().selectedText(sessionId)
	return `\n${heading} Pick up where you left off:\n  ${commandPrefix}--resume ${id}\n\n`
}

export function installResumeHintAdapter(
	proto: ShutdownMode = InteractiveMode.prototype as unknown as ShutdownMode,
): void {
	if (installed.has(proto)) return
	const shutdown = proto.shutdown
	proto.shutdown = async function (options) {
		if (this.isShuttingDown || options?.fromSignal) return shutdown.call(this, options)
		const write = process.stdout.write
		const sessionId = this.sessionManager.getSessionId()
		process.stdout.write = (chunk, ...args) =>
			Reflect.apply(write, process.stdout, [
				typeof chunk === "string" ? formatResumeHint(chunk, sessionId) : chunk,
				...args,
			])
		try {
			await shutdown.call(this, options)
		} finally {
			process.stdout.write = write
		}
	}
	installed.add(proto)
}

installResumeHintAdapter()
