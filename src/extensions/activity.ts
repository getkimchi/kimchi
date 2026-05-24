/**
 * activity — Unix domain socket activity bus.
 *
 * Creates /tmp/kimchi/{sessionId}.sock as a net.Server when running inside a
 * sandbox cluster (detected via isInSandboxCluster(): KIMCHI_SANDBOX=1 or both
 * homedir() === "/home/sandbox" AND username === "sandbox" as security fallback).
 *
 * Broadcasts NDJSON activity events to all connected clients (typically one:
 * the kimchi-sandbox-worker sidecar).
 *
 * Incoming NDJSON from clients is parsed but treated as a no-op for now
 * (reserved for future hibernate signals from the worker).
 */

import { chmodSync, mkdirSync, unlinkSync } from "node:fs"
import net from "node:net"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isInSandboxCluster } from "../utils/sandbox.js"

const SOCKET_DIR = "/tmp/kimchi"

export class ActivityBus {
	private server: net.Server | null = null
	private sockets: Set<net.Socket> = new Set()
	private sockPath: string | null = null

	/** True when the server is running (sandbox detected and start() succeeded). */
	isActive(): boolean {
		return this.server?.listening ?? false
	}

	/**
	 * Create the socket dir, unlink any stale socket, and start listening.
	 * No-op when not in a sandbox cluster.
	 */
	async start(sessionId: string): Promise<void> {
		if (!isInSandboxCluster()) return

		const sockPath = `${SOCKET_DIR}/${sessionId}.sock`
		this.sockPath = sockPath

		try {
			mkdirSync(SOCKET_DIR, { recursive: true })
		} catch {
			// best-effort — dir may already exist or be unwritable
		}

		// Remove stale socket file from a previous run.
		try {
			unlinkSync(sockPath)
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				// Unexpected — log and continue; bind will fail below if truly broken.
			}
		}

		const server = net.createServer((socket) => {
			this.sockets.add(socket)

			// Parse incoming NDJSON — no-op for now, reserved for hibernate signals.
			let buf = ""
			socket.on("data", (chunk) => {
				buf += chunk.toString()
				const lines = buf.split("\n")
				buf = lines.pop() ?? ""
				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed) continue
					try {
						JSON.parse(trimmed)
					} catch {
						// malformed — ignore
					}
				}
			})

			socket.on("close", () => this.sockets.delete(socket))
			socket.on("error", () => this.sockets.delete(socket))
		})

		this.server = server

		await new Promise<void>((resolve, reject) => {
			server.on("error", (err) => {
				console.error("ActivityBus server error:", err)
			})
			server.listen(sockPath, () => {
				try {
					chmodSync(sockPath, 0o600)
				} catch {
					// best-effort — chmod may fail on some platforms
				}
				resolve()
			})
			server.once("error", reject)
		}).catch((err) => {
			console.error("ActivityBus listen failed:", err)
			this.server = null
			this.sockPath = null
		})
	}

	/** Broadcast a JSON event as a single NDJSON line to all connected clients. */
	send(event: Record<string, unknown>): void {
		if (!this.isActive()) return
		const line = `${JSON.stringify(event)}\n`
		for (const socket of this.sockets) {
			try {
				socket.write(line)
			} catch {
				// best-effort — client may have disconnected
			}
		}
	}

	/**
	 * Send session_shutdown event, close all client sockets, close the server,
	 * and unlink the socket file.
	 */
	async stop(): Promise<void> {
		if (!this.isActive()) return
		this.send({ type: "session_shutdown" })
		for (const socket of this.sockets) {
			try {
				socket.end()
			} catch {
				// best-effort
			}
		}
		this.sockets.clear()
		await new Promise<void>((resolve) => {
			this.server?.close(() => resolve())
		})
		this.server = null
		if (this.sockPath) {
			try {
				unlinkSync(this.sockPath)
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					// ignore — socket may already be gone
				}
			}
			this.sockPath = null
		}
	}
}

export function createActivityExtension(): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI): void => {
		if (!isInSandboxCluster()) return

		const bus = new ActivityBus()

		pi.on("session_start", async (_event, ctx: ExtensionContext) => {
			const sessionId = ctx.sessionManager.getSessionId()
			await bus.start(sessionId)
		})

		pi.on("agent_start", () => {
			bus.send({ type: "agent_start" })
		})

		pi.on("agent_end", () => {
			bus.send({ type: "agent_end" })
		})

		pi.on("tool_execution_start", () => {
			bus.send({ type: "tool_execution_start" })
		})

		pi.events.on("subagents:started", (e) => {
			const event = e as { id: string }
			bus.send({ type: "subagents:started", id: event.id })
		})

		pi.events.on("subagents:completed", (e) => {
			const event = e as { id: string }
			bus.send({ type: "subagents:completed", id: event.id })
		})

		pi.events.on("subagents:failed", (e) => {
			const event = e as { id: string }
			bus.send({ type: "subagents:failed", id: event.id })
		})

		pi.on("session_shutdown", async () => {
			await bus.stop()
		})
	}
}

export default createActivityExtension()
