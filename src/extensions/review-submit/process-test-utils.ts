import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { SubmitResult } from "./store.js"

const PROCESS_ENTRY = fileURLToPath(new URL("./submit-process.ts", import.meta.url))

export interface SubmissionProcessResult {
	code: number | null
	signal: NodeJS.Signals | null
	stdout: string
	stderr: string
	result?: SubmitResult
}

export function runSubmissionProcess(options: {
	tool: "submit_finding" | "submit_summary" | "submit_reply"
	homeDir: string
	input: unknown
	killBeforeRename?: boolean
	runtime?: "node" | "bun"
}): Promise<SubmissionProcessResult> {
	const args = [options.tool, options.homeDir, JSON.stringify(options.input)]
	if (options.killBeforeRename) args.push("kill-before-rename")
	const runtime = options.runtime === "bun" ? "bun" : process.execPath
	const runtimeArgs = options.runtime === "bun" ? [] : ["--import", "tsx"]
	return new Promise((resolve, reject) => {
		const child = spawn(runtime, [...runtimeArgs, PROCESS_ENTRY, ...args], {
			env: {
				PATH: process.env.PATH,
				HOME: options.homeDir,
				SystemRoot: process.env.SystemRoot,
				TEMP: process.env.TEMP,
				TMP: process.env.TMP,
				REVIEW_WRITER: "final",
				REVIEW_WRITER_LIMIT: "50",
			},
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk))
		child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))
		const timeout = setTimeout(() => {
			child.kill("SIGKILL")
			reject(new Error(`Submission process timed out: ${stderr}`))
		}, 20_000)
		child.once("error", (error) => {
			clearTimeout(timeout)
			reject(error)
		})
		child.once("close", (code, signal) => {
			clearTimeout(timeout)
			let result: SubmitResult | undefined
			if (stdout) {
				try {
					result = JSON.parse(stdout) as SubmitResult
				} catch (error) {
					reject(new Error(`Invalid submission result ${stdout}: ${String(error)}`))
					return
				}
			}
			resolve({ code, signal, stdout, stderr, result })
		})
	})
}
