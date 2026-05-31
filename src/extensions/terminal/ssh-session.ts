import fs from "node:fs"
import type { ReadableStream, WritableStream } from "node:stream/web"
import { Duplex } from "stream"
import { Client, type ClientChannel } from "ssh2"
import type { TerminalArgs } from "./types.js"
import { connectTransport } from "./websocket.js"

export interface SshSessionCallbacks {
	onData: (data: string) => void
	onStderr: (data: string) => void
	onError: (err: Error) => void
	onClose: () => void
}

export class SshSession {
	private client: Client
	private stream?: ClientChannel
	private closed = false
	private _pendingResize: { rows: number; cols: number } | null = null

	constructor() {
		this.client = new Client()
	}

	async connect(args: TerminalArgs, callbacks: SshSessionCallbacks): Promise<void> {
		return new Promise(async (resolve, reject) => {
			this.client.on("ready", () => {
				this.client.shell(
					{
						// term: process.env.TERM ?? "xterm-256color",
						term: "xterm-256color",
						rows: args.rows ?? 24,
						cols: args.cols ?? 80,
					},
					(err, stream) => {
						if (err) {
							fs.appendFileSync("/tmp/log.txt", `Connenction error: ${(err as Error).message}\n`)
							reject(err)
							return
						}
						this.stream = stream
						if (this._pendingResize) {
							this.stream.setWindow(this._pendingResize.rows, this._pendingResize.cols, 0, 0)
						}
						stream.setEncoding("utf8")
						stream.on("data", callbacks.onData)
						stream.stderr.setEncoding("utf8")
						stream.stderr.on("data", callbacks.onStderr)
						stream.on("error", callbacks.onError)
						stream.on("close", () => {
							this.closed = true
							callbacks.onClose()
							this.client.end()
						})
						resolve()
					},
				)
			})

			this.client.on("error", reject)
			this.client.on("close", () => {
				if (!this.closed) {
					this.closed = true
					callbacks.onClose()
				}
			})

			this.client.on("keyboard-interactive", (_name, _instructions, _instructionsLang, prompts, finish) => {
				// For now, answer empty for all prompts. In a future iteration
				// we could prompt the user via pi's UI.
				finish(prompts.map(() => ""))
			})

			const transport = await connectTransport("", "")

			this.client.connect({
				host: args.host,
				port: args.port,
				username: args.user ?? process.env.USER ?? "root",
				tryKeyboard: true,
				agent: process.env.SSH_AUTH_SOCK,
				sock: transport,
			})
		})
	}

	write(data: string | Buffer): void {
		this.stream?.write(data)
	}

	resize(rows: number, cols: number): void {
		this._pendingResize = { rows, cols }
		this.stream?.setWindow(rows, cols, 0, 0)
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		this.stream?.close()
		this.client.end()
	}
}
