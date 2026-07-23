import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CouncilTransactionRuntime } from "./transaction-runtime.js"
import {
	COUNCIL_APPLY_TOOL,
	COUNCIL_DELETE_TOOL,
	COUNCIL_RENAME_TOOL,
	COUNCIL_SETTLE_TOOL,
	installCouncilMutationGuard,
	isCouncilPostApplyValidationCommand,
	registerCouncilTransactionTools,
	syncCouncilTransactionToolVisibility,
	withoutInternalCouncilTools,
} from "./transaction-tools.js"

interface ExecutableTool {
	name: string
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: (update: unknown) => void,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>
}

type ToolCallHandler = (
	event: { toolName: string; input?: unknown },
	ctx: ExtensionContext,
) => { block: true; reason: string } | undefined

const councilModel = {
	id: "council",
	name: "Kimchi Council",
	api: "kimchi-council",
	provider: "kimchi",
	baseUrl: "http://kimchi-council.invalid",
	reasoning: false,
	input: ["text"] as const,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262_144,
	maxTokens: 16_384,
} satisfies Model<Api>

const physicalModel = {
	...councilModel,
	id: "physical",
	name: "Physical",
	api: "openai-completions",
	provider: "openai",
} satisfies Model<Api>

function harness(initialActive = ["read", "edit", "write", "bash"]) {
	const tools = new Map<string, ExecutableTool>()
	const activeTools = new Set(initialActive)
	const on = vi.fn()
	const pi = {
		getActiveTools: vi.fn(() => [...activeTools]),
		on,
		registerTool: vi.fn((tool: ExecutableTool) => {
			tools.set(tool.name, tool)
			activeTools.add(tool.name)
		}),
		setActiveTools: vi.fn((names: string[]) => {
			activeTools.clear()
			for (const name of names) activeTools.add(name)
		}),
	} as unknown as ExtensionAPI

	return {
		activeTools,
		on,
		pi,
		tool(name: string): ExecutableTool {
			const tool = tools.get(name)
			if (!tool) throw new Error(`Missing registered tool: ${name}`)
			return tool
		},
	}
}

function context(cwd: string, model: Model<Api> = councilModel): ExtensionContext {
	return { cwd, model } as ExtensionContext
}

function execute(tool: ExecutableTool, params: Record<string, unknown>, ctx: ExtensionContext) {
	return tool.execute("call-1", params, new AbortController().signal, () => undefined, ctx)
}

describe("Council transaction tools", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await realpath(await mkdtemp(join(tmpdir(), "kimchi-council-tools-")))
	})

	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it.each([
		"pytest --basetemp .",
		"pytest --basetemp=.",
		"pytest --cache-clear",
		"pytest -c pytest.ini",
		"pytest -p unsafe_plugin",
		"jest --outputFile report.json",
		"jest --updateSnapshot",
		"jest --cacheDirectory=.cache",
		"jest --rootDir ..",
		"vitest run file.test.ts --outputFile=report.json",
		"vitest --config attacker.ts",
		"vitest --coverage.reportsDirectory=.",
		"vitest --watch",
		"go test -coverprofile coverage.out",
		"cargo test --target-dir .",
	])("rejects unsafe post-apply validator arguments in %s", (command) => {
		expect(isCouncilPostApplyValidationCommand(command)).toBe(false)
	})

	it.each([
		"npm test",
		"pnpm test",
		"pnpm run test:unit",
		"pnpm exec vitest run file.test.ts",
		"tsc --noEmit",
		"go test ./...",
		"cargo test",
	])("permits ordinary post-apply validation command %s", (command) => {
		expect(isCouncilPostApplyValidationCommand(command)).toBe(true)
	})

	it("passes non-Council tools through without consulting the transaction route", async () => {
		const runtimeLookup = vi.fn(() => {
			throw new Error("transaction lookup must not run")
		})
		const registered = harness()
		registerCouncilTransactionTools(registered.pi, workspace, runtimeLookup)

		const result = await execute(
			registered.tool("write"),
			{ path: "physical.txt", content: "physical" },
			context(workspace, physicalModel),
		)

		expect(runtimeLookup).not.toHaveBeenCalled()
		expect(await readFile(join(workspace, "physical.txt"), "utf8")).toBe("physical")
		expect(result).toEqual({
			content: [{ type: "text", text: "Successfully wrote 8 bytes to physical.txt" }],
			details: undefined,
		})
	})

	it("writes and reads the Council overlay while leaving the workspace unchanged", async () => {
		await writeFile(join(workspace, "note.txt"), "original\n")
		const runtime = new CouncilTransactionRuntime(workspace)
		const registered = harness()
		registerCouncilTransactionTools(registered.pi, workspace, () => runtime)

		await execute(registered.tool("write"), { path: "note.txt", content: "candidate\n" }, context(workspace))
		const result = await execute(registered.tool("read"), { path: "note.txt" }, context(workspace))

		expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe("original\n")
		expect(await runtime.current?.readBuffer("note.txt")).toEqual(Buffer.from("candidate\n"))
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("candidate") }),
		])
	})

	it("stages deletes and renames without touching their source files", async () => {
		await writeFile(join(workspace, "delete.txt"), "keep until promotion\n")
		await writeFile(join(workspace, "source.txt"), "rename candidate\n")
		const runtime = new CouncilTransactionRuntime(workspace)
		const registered = harness()
		registerCouncilTransactionTools(registered.pi, workspace, () => runtime)

		await execute(registered.tool(COUNCIL_DELETE_TOOL), { path: "delete.txt" }, context(workspace))
		await execute(
			registered.tool(COUNCIL_RENAME_TOOL),
			{ from_path: "source.txt", to_path: "renamed.txt" },
			context(workspace),
		)

		expect(runtime.current?.changeSet().operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "delete", path: "delete.txt" }),
				expect.objectContaining({ kind: "rename", fromPath: "source.txt", path: "renamed.txt" }),
			]),
		)
		expect(await readFile(join(workspace, "delete.txt"), "utf8")).toBe("keep until promotion\n")
		expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe("rename candidate\n")
		await expect(readFile(join(workspace, "renamed.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
		await expect(runtime.current?.readBuffer("source.txt")).rejects.toMatchObject({ code: "ENOENT" })
		expect(await runtime.current?.readBuffer("renamed.txt")).toEqual(Buffer.from("rename candidate\n"))
	})

	it("fails closed for unknown and mutating tools but permits reads and post-apply checks", () => {
		const registered = harness()
		const staging = { state: "staging" } as CouncilTransactionRuntime
		const postApply = {
			state: "post_apply_checks",
			isExpectedPostApplyValidationCommand: (command: string) => command === "pnpm test",
		} as unknown as CouncilTransactionRuntime
		let current = staging
		installCouncilMutationGuard(registered.pi, () => current)
		const handler = registered.on.mock.calls.find(([event]) => event === "tool_call")?.[1] as ToolCallHandler
		const ctx = context(workspace)

		expect(handler({ toolName: "mystery_mutator", input: {} }, ctx)).toMatchObject({ block: true })
		expect(handler({ toolName: "bash", input: { command: "echo changed > file.txt" } }, ctx)).toMatchObject({
			block: true,
		})
		expect(handler({ toolName: "read", input: { path: "file.txt" } }, ctx)).toBeUndefined()
		expect(handler({ toolName: "ask_user", input: { questions: [] } }, ctx)).toBeUndefined()
		expect(handler({ toolName: "bash", input: { command: "git status --short" } }, ctx)).toBeUndefined()

		current = postApply
		expect(handler({ toolName: "bash", input: { command: "pnpm test" } }, ctx)).toBeUndefined()
		expect(handler({ toolName: "bash", input: { command: "pnpm exec vitest run file.test.ts" } }, ctx)).toMatchObject({
			block: true,
		})
		expect(handler({ toolName: "bash", input: { command: "pytest --basetemp=." } }, ctx)).toMatchObject({
			block: true,
		})
		expect(handler({ toolName: "bash", input: { command: "vitest --outputFile report.json" } }, ctx)).toMatchObject({
			block: true,
		})
		expect(handler({ toolName: "bash", input: { command: "TOKEN=secret pnpm test" } }, ctx)).toMatchObject({
			block: true,
		})
		expect(handler({ toolName: "bash", input: { command: "echo bad > file.txt" } }, ctx)).toMatchObject({
			block: true,
		})
		expect(handler({ toolName: "bash", input: { command: "rm file.txt" } }, ctx)).toMatchObject({ block: true })
		expect(handler({ toolName: "mystery_mutator", input: {} }, ctx)).toMatchObject({ block: true })
	})

	it("rejects invalid and reused internal apply capabilities", async () => {
		await writeFile(join(workspace, "reviewed.txt"), "before\n")
		const runtime = new CouncilTransactionRuntime(workspace)
		const registered = harness()
		registerCouncilTransactionTools(registered.pi, workspace, () => runtime)
		await runtime.ensure().stageWrite("reviewed.txt", "after\n")
		const candidate = runtime.propose()
		const request = runtime.accept(candidate.patchSha256)
		const apply = registered.tool(COUNCIL_APPLY_TOOL)
		const ctx = context(workspace)
		const params = {
			token: request.token,
			transaction_id: request.transactionId,
			patch_sha256: request.patchSha256,
		}

		await expect(execute(apply, { ...params, token: "forged" }, ctx)).rejects.toThrow(
			"Council apply capability is invalid or already consumed",
		)
		await expect(execute(apply, params, ctx)).resolves.toMatchObject({
			content: [expect.objectContaining({ text: expect.stringContaining(candidate.patchSha256) })],
		})
		expect(await readFile(join(workspace, "reviewed.txt"), "utf8")).toBe("after\n")
		await expect(execute(apply, params, ctx)).rejects.toThrow("Council apply capability is invalid or already consumed")

		await runtime.abandon()
		expect(await readFile(join(workspace, "reviewed.txt"), "utf8")).toBe("before\n")
	})

	it("shows candidate tools only for Council and hides internal tools from physical calls", () => {
		const registered = harness()
		registerCouncilTransactionTools(registered.pi, workspace, () => undefined)

		syncCouncilTransactionToolVisibility(registered.pi, physicalModel)
		expect([...registered.activeTools]).toEqual(["read", "edit", "write", "bash"])

		syncCouncilTransactionToolVisibility(registered.pi, councilModel)
		expect([...registered.activeTools]).toEqual([
			"read",
			"edit",
			"write",
			"bash",
			COUNCIL_DELETE_TOOL,
			COUNCIL_RENAME_TOOL,
			COUNCIL_APPLY_TOOL,
			COUNCIL_SETTLE_TOOL,
		])
		expect(
			withoutInternalCouncilTools(
				[...registered.activeTools].map((name) => ({
					name,
				})),
			).map(({ name }) => name),
		).toEqual(["read", "edit", "write", "bash", COUNCIL_DELETE_TOOL, COUNCIL_RENAME_TOOL])
	})
})
