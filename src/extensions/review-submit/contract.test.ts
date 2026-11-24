import { type ChildProcess, fork } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import type { SubmitResult } from "./store.js"

const FIXTURE_DIR = fileURLToPath(new URL("./testdata/v1/", import.meta.url))
const WORKER_PATH = fileURLToPath(new URL("./contract-process.ts", import.meta.url))

interface FixtureCall {
	tool: "submit_finding" | "submit_summary" | "submit_reply"
	writer: string
	process?: string
	repeat?: number
	arguments: Record<string, unknown>
	generate_string_bytes?: Record<string, number>
	generate_array_lengths?: Record<string, number>
	expect: {
		accepted: boolean
		id?: string
		id_from_sequence?: boolean
		message_contains?: string[]
		[key: string]: unknown
	}
}

interface FixtureStep {
	name: string
	parallel?: boolean
	calls: FixtureCall[]
}

interface FixtureContract {
	fixed_created_at: string
	writer_limit: number
	steps: FixtureStep[]
}

interface WorkerResponse {
	request_id: number
	result?: SubmitResult
	error?: string
}

class FixtureProcess {
	private nextRequestId = 1
	private stderr = ""
	private readonly pending = new Map<
		number,
		{ resolve: (result: SubmitResult) => void; reject: (error: Error) => void }
	>()

	private constructor(private readonly child: ChildProcess) {
		child.stdout?.setEncoding("utf8")
		child.stderr?.setEncoding("utf8")
		child.stderr?.on("data", (chunk) => (this.stderr += chunk))
		child.on("message", (message: WorkerResponse) => {
			const pending = this.pending.get(message.request_id)
			if (!pending) return
			this.pending.delete(message.request_id)
			if (message.error || !message.result) pending.reject(new Error(message.error ?? "Worker returned no result"))
			else pending.resolve(message.result)
		})
		child.on("exit", (code, signal) => {
			const error = new Error(`Fixture worker exited early (code=${code}, signal=${signal}): ${this.stderr}`)
			for (const pending of this.pending.values()) pending.reject(error)
			this.pending.clear()
		})
	}

	static start(homeDir: string): FixtureProcess {
		// Only local process plumbing is inherited: no provider credentials and
		// package-manager/network use is disabled for the whole fixture run.
		const env: NodeJS.ProcessEnv = {
			HOME: homeDir,
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			TEMP: process.env.TEMP,
			TMP: process.env.TMP,
			npm_config_offline: "true",
			PNPM_OFFLINE: "true",
			GOPROXY: "off",
			GOSUMDB: "off",
			CARGO_NET_OFFLINE: "true",
			REVIEW_WRITER_LIMIT: "50",
		}
		return new FixtureProcess(
			fork(WORKER_PATH, [], {
				execPath: process.execPath,
				execArgv: ["--import", "tsx"],
				silent: true,
				env,
			}),
		)
	}

	async call(call: FixtureCall, args: Record<string, unknown>, fixedCreatedAt: string): Promise<SubmitResult> {
		const requestId = this.nextRequestId++
		return new Promise<SubmitResult>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(requestId)
				this.child.kill("SIGKILL")
				reject(new Error(`Timed out waiting for ${call.tool}: ${this.stderr}`))
			}, 15_000)
			this.pending.set(requestId, {
				resolve: (result) => {
					clearTimeout(timeout)
					resolve(result)
				},
				reject: (error) => {
					clearTimeout(timeout)
					reject(error)
				},
			})
			this.child.send(
				{
					request_id: requestId,
					tool: call.tool,
					writer: call.writer,
					arguments: args,
					fixed_created_at: fixedCreatedAt,
				},
				(error) => {
					if (!error) return
					clearTimeout(timeout)
					this.pending.delete(requestId)
					reject(error)
				},
			)
		})
	}

	async stop(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return
		const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()))
		this.child.kill("SIGTERM")
		await exited
	}
}

function materializeArguments(call: FixtureCall): Record<string, unknown> {
	const args = structuredClone(call.arguments)
	for (const [path, length] of Object.entries(call.generate_array_lengths ?? {})) {
		const prototype = args[path]
		if (!Array.isArray(prototype) || prototype.length === 0) throw new Error(`No array prototype for ${path}`)
		args[path] = Array.from({ length }, (_, index) => structuredClone(prototype[index % prototype.length]))
	}
	for (const [path, byteLength] of Object.entries(call.generate_string_bytes ?? {})) {
		const match = /^([^[\].]+)(?:\[(\d+)\])?(?:\.([^[\].]+))?$/.exec(path)
		if (!match) throw new Error(`Unsupported generated path ${path}`)
		const [, root, rawIndex, property] = match
		if (rawIndex === undefined) {
			args[root] = "x".repeat(byteLength)
			continue
		}
		const array = args[root]
		if (!Array.isArray(array)) throw new Error(`Generated path ${path} is not an array`)
		const index = Number(rawIndex)
		if (property === undefined) array[index] = "x".repeat(byteLength)
		else array[index][property] = "x".repeat(byteLength)
	}
	return args
}

function readOutput(outputRoot: string): Map<string, unknown> {
	const documents = new Map<string, unknown>()
	if (!existsSync(outputRoot)) return documents
	for (const kind of readdirSync(outputRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()) {
		const kindDir = join(outputRoot, kind)
		for (const file of readdirSync(kindDir).sort()) {
			const contents = readFileSync(join(kindDir, file), "utf8")
			documents.set(
				`${kind}/${file}`,
				kind === "summary"
					? JSON.parse(contents)
					: contents
							.trim()
							.split("\n")
							.filter(Boolean)
							.map((line) => JSON.parse(line)),
			)
		}
	}
	return documents
}

it("replays the complete vendored APA review-contract/v1 fixture", { timeout: 90_000 }, async () => {
	const contract = JSON.parse(readFileSync(join(FIXTURE_DIR, "calls.json"), "utf8")) as FixtureContract
	expect(contract.writer_limit).toBe(50)
	const homeDir = mkdtempSync(join(tmpdir(), "kimchi-apa-contract-"))
	cpSync(join(FIXTURE_DIR, "review-context"), join(homeDir, "review-context"), { recursive: true })
	const processes = new Map<string, FixtureProcess>()
	const workerFor = (name: string): FixtureProcess => {
		let worker = processes.get(name)
		if (!worker) {
			worker = FixtureProcess.start(homeDir)
			processes.set(name, worker)
		}
		return worker
	}

	try {
		for (const step of contract.steps) {
			const executeCall = async (call: FixtureCall): Promise<SubmitResult[]> => {
				const results: SubmitResult[] = []
				for (let repeat = 0; repeat < (call.repeat ?? 1); repeat += 1) {
					const args = materializeArguments(call)
					const result = await workerFor(call.process ?? "main").call(call, args, contract.fixed_created_at)
					const { message_contains: messageContains, id_from_sequence: idFromSequence, ...expected } = call.expect
					expect(result, `${step.name}: ${call.tool}`).toMatchObject(expected)
					for (const text of messageContains ?? []) expect(result.message, step.name).toContain(text)
					if (idFromSequence) expect(result.id, step.name).toBe(`${call.writer}-${result.seq}`)
					results.push(result)
				}
				return results
			}
			if (step.parallel) await Promise.all(step.calls.map(executeCall))
			else for (const call of step.calls) await executeCall(call)
		}

		const expected = readOutput(join(FIXTURE_DIR, "review-output"))
		const actual = readOutput(join(homeDir, "review-output"))
		expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort())
		for (const [path, expectedDocument] of expected) expect(actual.get(path), path).toEqual(expectedDocument)
		const finalFindings = actual.get("findings/final.jsonl") as Array<{ id: string; seq: number }>
		expect(finalFindings.map((finding) => finding.id)).toEqual(
			Array.from({ length: 50 }, (_, index) => `final-${index + 1}`),
		)
		expect(finalFindings.map((finding) => finding.seq)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1))
		const correctness = actual.get("findings/correctness.jsonl") as Array<{ id: string }>
		expect(correctness.map((finding) => finding.id)).toEqual(["correctness-1", "correctness-2", "correctness-3"])
	} finally {
		await Promise.all([...processes.values()].map((worker) => worker.stop()))
		rmSync(homeDir, { recursive: true, force: true })
	}
})
