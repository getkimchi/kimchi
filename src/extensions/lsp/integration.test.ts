/**
 * Integration smoke test for the LSP client.
 *
 * Boots a real `typescript-language-server` process against a minimal fixture,
 * then round-trips real LSP requests (hover, definition).
 *
 * Skipped automatically when `typescript-language-server` is not on PATH.
 */

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { getOrCreateClient, sendNotification, sendRequest, shutdownAll } from "./client.js"
import type { Hover, Location, LocationLink, ServerConfig } from "./types.js"
import { fileToUri } from "./utils.js"

// ---------------------------------------------------------------------------
// Binary availability check
// ---------------------------------------------------------------------------

const hasTsServer = spawnSync("which", ["typescript-language-server"], { stdio: "pipe" }).status === 0

// ---------------------------------------------------------------------------
// Fixture content
// ---------------------------------------------------------------------------

// index.ts content:
//   Line 0: export function greet(name: string): string {
//   Line 1:   return `Hello, ${name}!`
//   Line 2: }
//   Line 3: (blank)
//   Line 4: const msg = greet("world")
//
// hover target: position (0, 16) — inside "greet" in the definition
// definition target: position (4, 13) — inside "greet" in the call
const FIXTURE_INDEX_TS = `export function greet(name: string): string {
  return \`Hello, \${name}!\`
}

const msg = greet("world")
`

const FIXTURE_TSCONFIG = JSON.stringify(
	{
		compilerOptions: {
			target: "ES2020",
			module: "ESNext",
			strict: true,
		},
	},
	null,
	2,
)

// ---------------------------------------------------------------------------
// TS server config
// ---------------------------------------------------------------------------

const tsConfig: ServerConfig = {
	name: "typescript-language-server",
	command: "typescript-language-server",
	args: ["--stdio"],
	extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasTsServer)("LSP integration — typescript-language-server", () => {
	let tmpDir: string
	let indexPath: string
	let indexUri: string

	beforeAll(async () => {
		// Create temp directory with fixture files
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-lsp-integration-"))
		indexPath = join(tmpDir, "index.ts")
		writeFileSync(join(tmpDir, "tsconfig.json"), FIXTURE_TSCONFIG, "utf-8")
		writeFileSync(indexPath, FIXTURE_INDEX_TS, "utf-8")
		indexUri = fileToUri(indexPath)

		// Boot the server (may take several seconds on first run)
		const client = await getOrCreateClient(tsConfig, tmpDir)

		// Open the fixture file so the server indexes it
		await sendNotification(client, "textDocument/didOpen", {
			textDocument: {
				uri: indexUri,
				languageId: "typescript",
				version: 1,
				text: FIXTURE_INDEX_TS,
			},
		})

		// Give the server a moment to process the file
		await new Promise<void>((resolve) => setTimeout(resolve, 2000))
	}, 30_000)

	afterAll(async () => {
		shutdownAll()
		// Give kill signal time to propagate before cleaning temp files
		await new Promise<void>((resolve) => setTimeout(resolve, 500))
		try {
			rmSync(tmpDir, { recursive: true, force: true })
		} catch {
			// best-effort cleanup
		}
	})

	it("hover at function definition returns non-null result with content", async () => {
		const client = await getOrCreateClient(tsConfig, tmpDir)

		const result = await sendRequest(client, "textDocument/hover", {
			textDocument: { uri: indexUri },
			// position inside "greet" on line 0: character 16
			position: { line: 0, character: 16 },
		})

		expect(result).not.toBeNull()
		const hover = result as Hover
		expect(hover).toHaveProperty("contents")

		// contents can be a string, object, or array — just assert it's truthy
		const contents = hover.contents
		if (typeof contents === "string") {
			expect(contents.length).toBeGreaterThan(0)
		} else if (Array.isArray(contents)) {
			expect(contents.length).toBeGreaterThan(0)
		} else {
			expect((contents as { value: string }).value.length).toBeGreaterThan(0)
		}
	}, 30_000)

	it("definition at call-site resolves back to line 0 of the fixture", async () => {
		const client = await getOrCreateClient(tsConfig, tmpDir)

		const result = await sendRequest(client, "textDocument/definition", {
			textDocument: { uri: indexUri },
			// position inside "greet" on line 4: "const msg = greet("world")"
			//   0         1
			//   0123456789012345
			//   const msg = greet  → character 12
			position: { line: 4, character: 12 },
		})

		expect(result).not.toBeNull()

		// Result is either Location | Location[] | LocationLink[]
		let targetLine: number
		if (Array.isArray(result)) {
			expect(result.length).toBeGreaterThan(0)
			const first = result[0] as Location | LocationLink
			if ("targetUri" in first) {
				// LocationLink
				expect(first.targetUri).toBe(indexUri)
				targetLine = first.targetSelectionRange.start.line
			} else {
				// Location
				expect(first.uri).toBe(indexUri)
				targetLine = first.range.start.line
			}
		} else {
			// Single Location
			const loc = result as Location
			expect(loc.uri).toBe(indexUri)
			targetLine = loc.range.start.line
		}

		// The function definition is on line 0
		expect(targetLine).toBe(0)
	}, 30_000)
})
