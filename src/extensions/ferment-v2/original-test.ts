import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import {
	createBashTool,
	createLocalBashOperations,
	defineTool,
	type InlineExtension,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { textResult } from "../agents/tool-result.js"
import { createGitRunner, type TestInventoryFlag } from "./workspace.js"

export const RUN_ORIGINAL_TEST_TOOL = "run_original_test"
const parameters = Type.Object({
	flag: Type.String({ pattern: "^f[0-9]+$" }),
	runner: Type.String({ minLength: 1 }),
	args: Type.Array(Type.String()),
	cwd: Type.Optional(Type.String()),
	timeout: Type.Number({ minimum: 1, maximum: 600 }),
})

export interface OriginalTestReceipt {
	flag: string
	commit: string
	path: string
	sha256: string
	preparedPath: string
	cwd: string
	command: string
	exitCode: number
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
function contained(root: string, path: string): boolean {
	const rel = relative(root, path)
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")
}

/** Host selects the source and copy; permission checking and execution share one invocation. */
export function createOriginalTestRunner(options: {
	cwd: string
	commit: string
	flags: readonly TestInventoryFlag[]
}) {
	let repositoryRoot: string | undefined
	const getRoot = () =>
		(repositoryRoot ??= realpathSync(
			execFileSync("git", ["rev-parse", "--show-toplevel"], {
				cwd: options.cwd,
				encoding: "utf8",
				timeout: 10_000,
			}).trim(),
		))
	const receipts = new Map<string, OriginalTestReceipt>()
	const invocations = new Map<
		string,
		{ flag: string; path: string; preparedPath: string; cwd: string; command: string; timeout: number }
	>()
	function invocation(id: string, input: Record<string, unknown>) {
		const existing = invocations.get(id)
		if (existing) return existing
		const root = getRoot()
		const flag = options.flags.find(
			(flag) =>
				flag.id === input.flag && ["test_file_modified", "test_file_deleted", "test_file_renamed"].includes(flag.kind),
		)
		if (!flag) throw new Error("Select a host-issued modified, deleted, or renamed test flag.")
		const path = flag.kind === "test_file_renamed" && flag.detail?.startsWith("was ") ? flag.detail.slice(4) : flag.path
		const original = resolve(root, path)
		const parent = realpathSync(dirname(original))
		const cwd = realpathSync(resolve(options.cwd, typeof input.cwd === "string" ? input.cwd : "."))
		if (!contained(root, original) || !contained(root, parent) || !contained(root, cwd))
			throw new Error("Test and execution directory must stay inside the candidate repository.")
		if (
			typeof input.runner !== "string" ||
			!input.runner.trim() ||
			!Array.isArray(input.args) ||
			input.args.some((arg) => typeof arg !== "string") ||
			!input.args.includes("{test}")
		)
			throw new Error("Provide runner and args including a standalone {test} argument.")
		if (
			typeof input.timeout !== "number" ||
			!Number.isFinite(input.timeout) ||
			input.timeout < 1 ||
			input.timeout > 600
		)
			throw new Error("Set timeout between 1 and 600 seconds.")
		const name = basename(original)
		const preparedPath = resolve(
			parent,
			`${name.startsWith("test_") ? "test_" : ""}ferment-original-${randomUUID()}-${name}`,
		)
		const args = input.args.map((arg) => (arg === "{test}" ? preparedPath : String(arg)))
		const command = `cd ${quote(cwd)} && ${[input.runner, ...args].map(quote).join(" ")}`
		const result = { flag: flag.id, path, preparedPath, cwd, command, timeout: input.timeout }
		invocations.set(id, result)
		return result
	}
	const normalizeToolCall = (event: ToolCallEvent): ToolCallEvent => {
		if (event.toolName !== RUN_ORIGINAL_TEST_TOOL) return event
		const call = invocation(event.toolCallId, event.input)
		return { ...event, toolName: "bash", input: { command: call.command, timeout: call.timeout } }
	}
	const extension: InlineExtension = (pi) => {
		pi.registerTool(
			defineTool({
				name: RUN_ORIGINAL_TEST_TOOL,
				label: "Run Original Test",
				description:
					"Run a flagged original test from the fixed baseline against candidate code. Supply runner (e.g. pnpm), args (e.g. [exec, vitest, run, {test}]), relative cwd, and timeout seconds. The host creates and removes an adjacent original copy. A failed assertion is evidence, not an automatic verdict. Missing historical fixtures/imports are setup limitations.",
				parameters,
				execute: async (id, input, signal) => {
					let preparedPath: string | undefined
					try {
						const call = invocation(id, input)
						if (signal?.aborted) throw new Error("Original-test execution cancelled.")
						const source = await createGitRunner(getRoot()).run(["show", `${options.commit}:${call.path}`], { signal })
						writeFileSync(call.preparedPath, source, { flag: "wx" })
						preparedPath = call.preparedPath
						let exitCode: number | null = null
						const local = createLocalBashOperations()
						const bash = createBashTool(options.cwd, {
							operations: {
								exec: async (...args) => {
									const result = await local.exec(...args)
									exitCode = result.exitCode
									return result
								},
							},
						})
						const output = await bash
							.execute(id, { command: call.command, timeout: call.timeout }, signal)
							.catch((error: unknown) => {
								if (exitCode === null || signal?.aborted) throw error
								return { ...textResult(error instanceof Error ? error.message : String(error)), isError: true }
							})
						if (signal?.aborted || exitCode === null) throw new Error("Original-test execution interrupted.")
						if (hash(readFileSync(preparedPath)) !== hash(source))
							throw new Error("Prepared original test changed during execution; provenance rejected.")
						const receipt: OriginalTestReceipt = { ...call, commit: options.commit, sha256: hash(source), exitCode }
						receipts.set(id, receipt)
						return {
							...output,
							content: [
								...output.content,
								{ type: "text" as const, text: `Original-test receipt: ${JSON.stringify(receipt)}` },
							],
						}
					} catch (error) {
						return {
							...textResult(
								`Original-test execution unavailable: ${error instanceof Error ? error.message : String(error)}`,
							),
							isError: true,
						}
					} finally {
						if (preparedPath) rmSync(preparedPath, { force: true })
						invocations.delete(id)
					}
				},
			}),
		)
	}
	return { extension, normalizeToolCall, receipt: (id: string) => receipts.get(id) }
}
