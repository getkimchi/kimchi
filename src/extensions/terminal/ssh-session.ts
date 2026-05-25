import { Client, type ClientChannel } from "ssh2"
import type { TerminalArgs } from "./types.js"

export interface SshSessionCallbacks {
	onData: (data: Buffer) => void
	onError: (err: Error) => void
	onClose: () => void
}

export class SshSession {
	private client: Client
	private stream?: ClientChannel
	private closed = false

	constructor() {
		this.client = new Client()
	}

	async connect(args: TerminalArgs, callbacks: SshSessionCallbacks): Promise<void> {
		return new Promise((resolve, reject) => {
			this.client.on("ready", () => {
				this.client.shell({
					term: process.env.TERM ?? "xterm-256color",
					rows: 24,
					cols: 80,
				}, (err, stream) => {
					if (err) {
						reject(err)
						return
					}
					this.stream = stream
					stream.on("data", callbacks.onData)
					stream.on("error", callbacks.onError)
					stream.on("close", () => {
						this.closed = true
						callbacks.onClose()
						this.client.end()
					})
					resolve()
				})
			})

			this.client.on("error", reject)
			this.client.on("close", () => {
				if (!this.closed) {
					this.closed = true
					callbacks.onClose()
				}
			})

			this.client.connect({
				host: args.host,
				port: args.port,
				username: args.user ?? process.env.USER ?? "root",
				tryKeyboard: true,
				agent: process.env.SSH_AUTH_SOCK,
			})
		})
	}

	write(data: string | Buffer): void {
		this.stream?.write(data)
	}

	resize(rows: number, cols: number): void {
		this.stream?.setWindow(rows, cols, 0, 0)
	}

	close(): void {
		this.closed = true
		this.stream?.close()
		this.client.end()
	}
}
