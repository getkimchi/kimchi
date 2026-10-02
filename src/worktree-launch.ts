import { spawn } from "node:child_process"
import { constants } from "node:os"
import { getAgentInvocation } from "./utils/spawn-kimchi-subprocess.js"

/** A fresh process gives tools, trust, settings and session storage the same cwd. */
export function runInWorkspace(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const invocation = getAgentInvocation(args)
	return new Promise((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, { cwd, stdio: "inherit", env })
		const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
			const handler = () => {
				child.kill(signal)
			}
			process.on(signal, handler)
			return { signal, handler }
		})
		const cleanup = () => {
			for (const { signal, handler } of handlers) process.off(signal, handler)
		}
		child.once("error", (error) => {
			cleanup()
			reject(error)
		})
		child.once("exit", (code, signal) => {
			cleanup()
			resolve(code ?? (signal ? 128 + constants.signals[signal] : 1))
		})
	})
}
