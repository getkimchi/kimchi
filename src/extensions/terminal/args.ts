import type { TerminalArgs } from "./types.js"

export function parseTerminalArgs(raw: string): TerminalArgs {
	const rest = raw.trim()
	if (!rest) {
		throw new Error("Usage: /terminal [user@]host[:port]")
	}

	let user: string | undefined
	let hostWithPort = rest

	const atIndex = rest.lastIndexOf("@")
	if (atIndex !== -1) {
		user = rest.slice(0, atIndex) || undefined
		hostWithPort = rest.slice(atIndex + 1)
	}

	let host = hostWithPort
	let port = 22

	const bracketEnd = hostWithPort.indexOf("]")
	if (hostWithPort.startsWith("[")) {
		if (bracketEnd === -1) {
			throw new Error("Invalid IPv6 address: missing closing bracket")
		}
		host = hostWithPort.slice(1, bracketEnd)
		const portPart = hostWithPort.slice(bracketEnd + 1)
		if (portPart.startsWith(":")) {
			port = Number(portPart.slice(1))
		}
	} else {
		const colonIndex = hostWithPort.lastIndexOf(":")
		if (colonIndex !== -1) {
			const maybePort = hostWithPort.slice(colonIndex + 1)
			if (!Number.isNaN(Number(maybePort))) {
				host = hostWithPort.slice(0, colonIndex)
				port = Number(maybePort)
			}
		}
	}

	if (!host) {
		throw new Error("Usage: /terminal [user@]host[:port]")
	}

	return { host, port, user }
}
