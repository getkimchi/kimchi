import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/** Repo root, resolved from this file's location (src/extensions/prompt-construction/)
 *  so the contract test is independent of the process working directory. */
const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)))

function readSource(relativePath: string): string {
	return readFileSync(resolve(REPO_ROOT, relativePath), "utf8")
}

interface BlockRegistrar {
	file: string
	owner: string
	blockId: string
	expectedStability: "static" | "dynamic"
	reason: string
	/** Volatile-store imports that are allowed in a static block's file.
	 *  Use sparingly and document why the imported code is not used by the
	 *  block's render path. */
	allowedVolatileImports?: { modulePath: string; reason: string }[]
}

/** Canonical registry of every system-prompt block in src/extensions.
 *
 *  Adding a new block requires an entry here. The test fails if the source
 *  contains a `createSystemPromptBlocks(` call for a block not listed, so
 *  authors must consciously classify their block as static (cache-friendly)
 *  or dynamic (expected to change during a session).
 */
const KNOWN_REGISTRARS: BlockRegistrar[] = [
	{
		file: "src/extensions/todos/ferment-prompt-block.ts",
		owner: "todos",
		blockId: "todo-guidance-ferment",
		expectedStability: "dynamic",
		reason:
			"ferment todo supplement appears only while a ferment is active. The base static " +
			"todo-guidance block was removed together with the user-facing todo feature — todo " +
			"machinery is ferment-internal now, so this is the only todos prompt block.",
	},
	{
		file: "src/extensions/ferment/index.ts",
		owner: "ferment",
		blockId: "ferment-planning-block",
		expectedStability: "dynamic",
		reason: "ferment planner supplement legitimately changes with ferment lifecycle status",
	},
	{
		file: "src/extensions/permissions/index.ts",
		owner: "permissions",
		blockId: "plan-mode-supplement",
		expectedStability: "dynamic",
		reason: "plan mode supplement is intentionally shown only when plan permission mode is active",
	},
	{
		file: "src/extensions/behaviours/rules-block.ts",
		owner: "behaviours",
		blockId: "rules",
		expectedStability: "static",
		reason:
			"baseline behaviour rules are a constant computed once from the behaviour manifest; " +
			"kept separate from the dynamic triggered:* registrar so the file can be held to zero volatile symbols",
	},
	{
		file: "src/extensions/behaviours/wiring.ts",
		owner: "behaviours",
		blockId: "triggered:*",
		expectedStability: "dynamic",
		reason: "triggered behaviour bodies are loaded/unloaded based on runtime signals",
	},
	{
		file: "src/extensions/lsp.ts",
		owner: "lsp",
		blockId: "lsp-tools",
		expectedStability: "dynamic",
		reason: "LSP block reflects the detected servers for the current working directory",
	},
	{
		file: "src/extensions/dap.ts",
		owner: "dap",
		blockId: "dap-*",
		expectedStability: "dynamic",
		reason:
			"dap-tools + 6 language skill blocks are detection- and state-gated: the tools block appears " +
			"when a debug adapter is discovered in cwd, language skills appear once their adapter is " +
			"activated at session start, so visibility legitimately changes during a session",
	},
]

/** Modules that hold per-turn or per-action mutable session state.
 *
 *  Static system-prompt blocks must not import from these modules. Dynamic
 *  blocks may import from them only when the resulting variability is
 *  intentional and bounded (e.g. ferment lifecycle, permission mode).
 *
 *  Each entry covers the relative and src-rooted spellings used by registrars
 *  in src/extensions so an import is caught however it is written. */
const VOLATILE_STORE_MODULES = [
	"../todos/store",
	"./store",
	"src/extensions/todos/store",
	"../ferment/state",
	"./state",
	"src/extensions/ferment/state",
	"../ferment/todo-sync",
	"./todo-sync",
	"src/extensions/ferment/todo-sync",
]

const VOLATILE_SYMBOLS = [
	"getActive(",
	"isLoaded(",
	"getRuntimePermissionMode(",
	"Date.now(",
	"Math.random(",
	"randomUUID(",
]

function hasBlockRegistration(source: string, owner: string, blockId: string): boolean {
	// Match createSystemPromptBlocks(pi, "owner").register(...) or similar.
	const ownerPattern = new RegExp(`createSystemPromptBlocks\\([^)]+,\\s*["']${owner}["']\\s*\\)`)
	if (!ownerPattern.test(source)) return false

	if (blockId.includes("*")) {
		// Wildcard prefix match, e.g. triggered:* — the source may use a
		// template literal (`triggered:${b.name}`) instead of a quoted string.
		const prefix = blockId.replace("*", "")
		return source.includes(`id: "${prefix}`) || source.includes(`id: \`${prefix}`)
	}

	return source.includes(`id: "${blockId}"`)
}

function hasImport(source: string, modulePath: string): boolean {
	// Import statements in this repo use explicit `.js` extensions; match the
	// base path with an optional `.js` suffix.
	const escaped = modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	return new RegExp(`from\\s+["']${escaped}(?:\\.js)?["']`).test(source)
}

function fileExists(relativePath: string): boolean {
	try {
		readSource(relativePath)
		return true
	} catch {
		return false
	}
}

/** Return every call site of createSystemPromptBlocks in src/extensions. */
function scanForUnregisteredRegistrars(): { file: string; owner: string }[] {
	// Vitest runs in Node, so we can use the real file system via a shell call.
	// execSync is allowed here because this is a test-time diagnostic, not a
	// source-code dependency.
	const raw = execSync(
		`grep -R "createSystemPromptBlocks(" src/extensions --include="*.ts" -l | grep -v ".test.ts" | sort`,
		{ encoding: "utf8", cwd: REPO_ROOT },
	)
	const files = raw.split("\n").filter(Boolean)
	const unregistered: { file: string; owner: string }[] = []
	for (const file of files) {
		const source = readSource(file)
		// Extract owner strings: createSystemPromptBlocks(pi, "owner")
		const matches = source.matchAll(/createSystemPromptBlocks\([^)]+,\s*["']([^"']+)["']\s*\)/g)
		for (const match of matches) {
			const owner = match[1]
			const known = KNOWN_REGISTRARS.some((r) => r.file === file && r.owner === owner)
			if (!known) {
				unregistered.push({ file, owner })
			}
		}
	}
	return unregistered
}

describe("system-prompt block cache contract (source)", () => {
	it("has an entry for every createSystemPromptBlocks registrar", () => {
		const unregistered = scanForUnregisteredRegistrars()
		expect(unregistered).toEqual([])
	})

	for (const registrar of KNOWN_REGISTRARS) {
		describe(`${registrar.file} → ${registrar.owner}/${registrar.blockId}`, () => {
			it("is still registered", () => {
				expect(fileExists(registrar.file)).toBe(true)
				const source = readSource(registrar.file)
				expect(hasBlockRegistration(source, registrar.owner, registrar.blockId)).toBe(true)
			})

			if (registrar.expectedStability === "static") {
				it("does not import volatile session stores", () => {
					const source = readSource(registrar.file)
					const allowed = new Map((registrar.allowedVolatileImports ?? []).map((a) => [a.modulePath, a.reason]))
					for (const modulePath of VOLATILE_STORE_MODULES) {
						if (allowed.has(modulePath)) continue
						expect(hasImport(source, modulePath), `static block should not import from ${modulePath}`).toBe(false)
					}
				})

				it("does not call volatile runtime symbols", () => {
					const source = readSource(registrar.file)
					for (const symbol of VOLATILE_SYMBOLS) {
						expect(source, `static block should not call ${symbol}`).not.toContain(symbol)
					}
				})
			}
		})
	}

	it("keeps the user-facing todo prompt block removed and reintroducing todo-state impossible by omission", () => {
		const fermentBlock = readSource("src/extensions/todos/ferment-prompt-block.ts")
		const core = readSource("src/extensions/todos/core.ts")

		// The static `## Todos` base block (`id: "todo-guidance"`) was deleted
		// with the user-facing todo feature: no todos registrar may reintroduce
		// unconditional todo guidance into the adhoc system prompt.
		expect(fermentBlock).not.toContain('id: "todo-guidance"')
		expect(fermentBlock).not.toContain("registerTodoStateBlock")

		expect(fermentBlock).toContain('id: "todo-guidance-ferment"')

		expect(core).toContain("registerTodoStatePersistence(pi)")
		expect(core).toContain("registerFermentTodoPromptBlock(pi)")
		expect(core).not.toContain("registerTodoStateBlock")
		expect(core).not.toContain("registerTodoPromptBlock")
	})

	it("delivers dynamic state via persist-on-change, never via tail-push", () => {
		const contextState = readSource("src/extensions/todos/context-state.ts")
		const lifecycleContext = readSource("src/extensions/ferment/lifecycle-context.ts")
		const stateMarkdown = readSource("src/extensions/todos/state-markdown.ts")
		const todosCore = readSource("src/extensions/todos/core.ts")

		// Persist-on-change: state blocks are written to session history via
		// sendMessage, so they join the growing stable prefix. The machinery is
		// shared; each registrar wires its customType + render source into it.
		const sharedPersistence = readSource("src/extensions/state-block-persistence.ts")
		expect(sharedPersistence).toContain("pi.sendMessage")
		expect(sharedPersistence).toContain("isStateBlockEntry")
		expect(contextState).toContain("registerStateBlockPersistence")
		expect(contextState).toContain("renderTodoStateMarkdown")
		expect(lifecycleContext).toContain("registerStateBlockPersistence")

		// Tail-push ban: no writes to the message array inside a context handler.
		// The context handlers in these files are strip-only (drop superseded
		// copies of persisted blocks) — appending state blocks at the request
		// tail permanently poisons the provider cache breakpoint.
		expect(contextState).not.toContain("messages.push")
		expect(contextState).not.toContain("event.messages.push")
		expect(lifecycleContext).not.toContain("messages.push")
		expect(lifecycleContext).not.toContain("event.messages.push")
		expect(sharedPersistence).not.toContain("messages.push")
		expect(sharedPersistence).not.toContain("event.messages.push")

		// The todos core wires persistence, not transient injection.
		expect(todosCore).toContain("registerTodoStatePersistence(pi)")
		expect(todosCore).not.toContain("registerTodoContextState")

		// The renderer lives outside any registrar file so the static
		// import guard above can be strict (zero allowlisted exceptions).
		expect(stateMarkdown).toContain("renderTodoStateMarkdown")

		// The persisted block is a pure function of the store: no volatile
		// staleness counters, no wall-clock.
		expect(stateMarkdown).not.toContain("getToolCallsSinceTodoWrite")
		expect(stateMarkdown).not.toContain("getTurnsSinceStepTodoWrite")
		expect(stateMarkdown).not.toContain("Date.now(")
	})
})
