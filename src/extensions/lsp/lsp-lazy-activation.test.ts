// Wiring tests for lazy mid-session LSP activation: a session that starts
// with no language server (empty dir, binary missing, or started outside the
// project tree) gains one when a server-supported file inside a materialized
// project is touched. The real detection primitive (detectServerForPath,
// findRoot, serverForFile, detectServers) runs against the real filesystem —
// only the LSP client chain is mocked — so these tests pin the handler-level
// contract: the single unthrottled trigger (every suppression mechanism is
// also a miss mechanism), the single-winner stop, read-only detection, and
// the activation-root workspace relaxation for sessions started elsewhere.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type * as NodeUtil from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"

const mocks = vi.hoisted(() => ({
	getOrCreateClient: vi.fn(),
	ensureFileOpen: vi.fn(async () => {}),
	refreshFile: vi.fn(async () => {}),
	waitForDiagnostics: vi.fn(async () => false),
}))

// Binaries visible to `which` — mutable per test so a binary can "install"
// mid-session. exists() re-evaluates on every scan (nothing caches a miss),
// which is exactly what the late-install test exercises.
const binaries = vi.hoisted(() => ({ available: ["pyright-langserver"] }))

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn((_cmd: string, args: string[]) => ({
		status: binaries.available.includes(args[0] ?? "") ? 0 : 1,
	})),
}))

vi.mock("./client.js", () => ({
	getOrCreateClient: mocks.getOrCreateClient,
	ensureFileOpen: mocks.ensureFileOpen,
	pullDiagnostics: vi.fn(async () => []),
	refreshFile: mocks.refreshFile,
	waitForDiagnostics: mocks.waitForDiagnostics,
	sendRequest: vi.fn(),
	shutdownAll: vi.fn(),
	beginClientWork: vi.fn(() => () => {}),
	noteSessionStart: vi.fn(),
	noteSessionEnd: vi.fn(),
}))

// Real servers module, with detectServerForPath wrapped in a delegating spy
// so tests can assert scan counts (the single-winner stop) while keeping the
// real ancestor-marker walk.
vi.mock("./servers.js", async (importOriginal) => {
	const original = await importOriginal<typeof ServersModule>()
	return { ...original, detectServerForPath: vi.fn(original.detectServerForPath) }
})

// Capture the registered lsp-tools block to assert the prompt flips after
// activation (it renders on the next prompt rebuild in real sessions).
const blockCapture = vi.hoisted(() => ({
	block: undefined as { id: string; render: () => string | undefined } | undefined,
}))
vi.mock("../prompt-construction/index.js", () => ({
	createSystemPromptBlocks: vi.fn(() => ({
		register: (block: { id: string; render: () => string | undefined }) => {
			blockCapture.block = block
		},
	})),
}))

// Real tool-visibility registry — the lazy path must remove the session-start
// disable vote, which the extension-api mock observes via getActiveToolNames.
vi.mock("../steer-marker.js", () => ({
	markHarnessSteer: vi.fn((content: string) => content),
}))

const { debug } = vi.hoisted(() => ({ debug: vi.fn() }))
vi.mock("node:util", async (importOriginal) => ({
	...(await importOriginal<typeof NodeUtil>()),
	debuglog: () => debug,
}))

import lspExtension, { LSP_TOOL_NAMES } from "../lsp.js"
import type * as ServersModule from "./servers.js"
import * as serversMod from "./servers.js"

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
	tempDirs.push(dir)
	return dir
}

/** Write a marker file (creating parents) into dir. */
function seedMarker(dir: string, marker: string): void {
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(dir, marker), marker === "go.mod" ? "module example.com/x\n\ngo 1.22\n" : "{}\n")
}

function writeToolResult(filePath: string) {
	return { toolName: "write", isError: false, input: { path: filePath }, content: [], details: undefined }
}

function readToolResult(filePath: string) {
	return { toolName: "read", isError: false, input: { path: filePath }, content: [], details: undefined }
}

function editToolResult(filePath: string) {
	return { toolName: "edit", isError: false, input: { path: filePath }, content: [], details: undefined }
}

function makeSession() {
	const ext = createExtensionApi()
	lspExtension(ext.api)
	return ext
}

async function startSession(ext: ReturnType<typeof makeSession>, cwd: string) {
	const ctx = createContext({ cwd })
	await ext.getHandler<unknown, unknown>("session_start")(null, ctx)
	return ctx
}

async function fireToolResult(
	ext: ReturnType<typeof makeSession>,
	event: unknown,
	ctx: ReturnType<typeof createContext>,
) {
	await ext.getHandler<unknown, unknown>("tool_result")(event, ctx)
}

/** Text of a tool result's first content block ("" for non-text content). */
function firstContentText(result: unknown): string {
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content
	const first = content?.[0]
	return first?.type === "text" ? (first.text ?? "") : ""
}

function activeTools(ext: ReturnType<typeof makeSession>): string[] {
	return ext.getActiveToolNames()
}

beforeEach(() => {
	binaries.available = ["pyright-langserver"]
	mocks.getOrCreateClient.mockReset().mockResolvedValue({ diagnostics: new Map() })
	mocks.ensureFileOpen.mockReset().mockResolvedValue(undefined)
	mocks.refreshFile.mockReset().mockResolvedValue(undefined)
	mocks.waitForDiagnostics.mockReset().mockResolvedValue(false)
	vi.mocked(serversMod.detectServerForPath).mockClear()
	debug.mockReset()
})

afterEach(() => {
	vi.clearAllMocks()
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

describe("lazy activation — trigger, single-winner, and reset", () => {
	it("activates on a source touch inside a scaffolded project and reveals the lsp_* tools", async () => {
		const dir = makeTempDir("kimchi-lsp-lazy-")
		const project = path.join(dir, "proj")
		const ext = makeSession()
		const ctx = await startSession(ext, dir)

		// Session starts LSP-less: the tools are hidden…
		for (const name of LSP_TOOL_NAMES) {
			expect(activeTools(ext)).not.toContain(name)
		}
		// …and the prompt block renders nothing.
		expect(blockCapture.block?.id).toBe("lsp-tools")
		expect(blockCapture.block?.render()).toBeUndefined()

		// The agent scaffolds the project: marker first, then source. The
		// marker write alone must not activate — marker files (.toml, .json,
		// .mod) carry no server-supported extension, so detection cannot key
		// off them by construction.
		seedMarker(project, "pyproject.toml")
		await fireToolResult(ext, writeToolResult(path.join(project, "pyproject.toml")), ctx)
		for (const name of LSP_TOOL_NAMES) {
			expect(activeTools(ext)).not.toContain(name)
		}

		// The first source touch activates: pyright, rooted at the marker dir.
		const mainPy = path.join(project, "main.py")
		await fireToolResult(ext, writeToolResult(mainPy), ctx)
		for (const name of LSP_TOOL_NAMES) {
			expect(activeTools(ext)).toContain(name)
		}
		// The client chain is keyed at the activation root (the matched
		// marker's directory), and the file syncs through it.
		expect(mocks.getOrCreateClient).toHaveBeenCalledWith(expect.objectContaining({ name: "pyright" }), project)
		expect(mocks.refreshFile).toHaveBeenCalledWith(expect.anything(), mainPy)

		// The statusline mirrors the session-start activation message…
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("lsp", "LSP: pyright")
		// …and the prompt block now renders guidance for the next rebuild.
		expect(blockCapture.block?.render()).toContain("Language Server Protocol")
		expect(debug).toHaveBeenCalledWith(expect.stringContaining("activated mid-session"))
	})

	it("never activates on scratch files with no ancestor marker", async () => {
		const dir = makeTempDir("kimchi-lsp-scratch-")
		const ext = makeSession()
		const ctx = await startSession(ext, dir)

		await fireToolResult(ext, writeToolResult(path.join(dir, "scratch.py")), ctx)

		for (const name of LSP_TOOL_NAMES) {
			expect(activeTools(ext)).not.toContain(name)
		}
		expect(mocks.getOrCreateClient).not.toHaveBeenCalled()
		expect(ctx.ui.setStatus).not.toHaveBeenCalled()
	})

	it("does not re-detect once a server is active — session-start detection wins", async () => {
		const dir = makeTempDir("kimchi-lsp-gosession-")
		seedMarker(dir, "go.mod")
		binaries.available = ["gopls"]
		const ext = makeSession()
		const ctx = await startSession(ext, dir)
		expect(activeTools(ext)).toContain("lsp_diagnostics")

		// A Python project materializes INSIDE the session workspace after a
		// gopls session is already active — single-winner means no detection.
		const project = path.join(dir, "sub")
		seedMarker(project, "pyproject.toml")
		vi.mocked(serversMod.detectServerForPath).mockClear()
		await fireToolResult(ext, writeToolResult(path.join(project, "main.py")), ctx)

		expect(vi.mocked(serversMod.detectServerForPath)).not.toHaveBeenCalled()
		expect(mocks.getOrCreateClient).not.toHaveBeenCalled()
	})

	it("does not re-detect after a lazy activation — the first winner is final", async () => {
		const dir = makeTempDir("kimchi-lsp-winner-")
		const project = path.join(dir, "proj")
		const ext = makeSession()
		const ctx = await startSession(ext, dir)
		// Nothing is seeded yet — the session starts LSP-less. (Seeding the
		// marker before session_start would let the session-start downward
		// scan activate pyright, and the lazy path would never run.)
		for (const name of LSP_TOOL_NAMES) {
			expect(activeTools(ext)).not.toContain(name)
		}

		seedMarker(project, "pyproject.toml")
		await fireToolResult(ext, writeToolResult(path.join(project, "main.py")), ctx)
		expect(activeTools(ext)).toContain("lsp_diagnostics")

		// A second, different-language project cannot replace the winner.
		const goProject = path.join(dir, "goproj")
		seedMarker(goProject, "go.mod")
		vi.mocked(serversMod.detectServerForPath).mockClear()
		await fireToolResult(ext, writeToolResult(path.join(goProject, "main.go")), ctx)

		expect(vi.mocked(serversMod.detectServerForPath)).not.toHaveBeenCalled()
		expect(mocks.getOrCreateClient).not.toHaveBeenCalledWith(
			expect.objectContaining({ name: "gopls" }),
			expect.anything(),
		)
	})

	it("activates when the marker directory materializes between touches (clone / external change)", async () => {
		const dir = makeTempDir("kimchi-lsp-clone-")
		const project = path.join(dir, "proj")
		const ext = makeSession()
		const ctx = await startSession(ext, dir)

		// First touch: no marker anywhere on the file's ancestry — a miss.
		await fireToolResult(ext, writeToolResult(path.join(project, "main.py")), ctx)
		expect(activeTools(ext)).not.toContain("lsp_diagnostics")

		// The marker lands with NO tool event (bash clone, git checkout,
		// editor write) — the next source touch must still activate, which is
		// exactly what the unthrottled design guarantees: no cooldown window
		// to miss.
		seedMarker(project, "pyproject.toml")
		await fireToolResult(ext, writeToolResult(path.join(project, "main.py")), ctx)
		expect(activeTools(ext)).toContain("lsp_diagnostics")
	})

	it("re-scans after the server binary appears mid-session (late install)", async () => {
		const dir = makeTempDir("kimchi-lsp-latebin-")
		const project = path.join(dir, "proj")
		seedMarker(project, "pyproject.toml")
		binaries.available = [] // pyright is NOT installed
		const ext = makeSession()
		const ctx = await startSession(ext, dir)

		// Marker present but binary missing: detection misses every touch…
		await fireToolResult(ext, writeToolResult(path.join(project, "main.py")), ctx)
		await fireToolResult(ext, writeToolResult(path.join(project, "main.py")), ctx)
		expect(activeTools(ext)).not.toContain("lsp_diagnostics")

		// …the binary installs mid-session (exists() re-evaluates, nothing
		// caches the miss) — the next source touch activates.
		binaries.available = ["pyright-langserver"]
		await fireToolResult(ext, writeToolResult(path.join(project, "main.py")), ctx)
		expect(activeTools(ext)).toContain("lsp_diagnostics")
	})

	it("reads trigger detection but never spawn chains or open documents", async () => {
		const dir = makeTempDir("kimchi-lsp-read-")
		const project = path.join(dir, "proj")
		const ext = makeSession()
		const ctx = await startSession(ext, dir)
		// The session starts LSP-less — the only path to activation below is
		// the read itself (seeding before session_start would let the
		// session-start downward scan activate pyright instead).
		for (const name of LSP_TOOL_NAMES) {
			expect(activeTools(ext)).not.toContain(name)
		}

		seedMarker(project, "pyproject.toml")
		await fireToolResult(ext, readToolResult(path.join(project, "main.py")), ctx)

		// Detection ran (tools revealed)…
		for (const name of LSP_TOOL_NAMES) {
			expect(activeTools(ext)).toContain(name)
		}
		// …but reads keep their no-spawn/no-open behavior.
		expect(mocks.getOrCreateClient).not.toHaveBeenCalled()
		expect(mocks.ensureFileOpen).not.toHaveBeenCalled()
		expect(mocks.refreshFile).not.toHaveBeenCalled()
	})

	it("a new session_start resets a previous lazy activation", async () => {
		const sessionDir = makeTempDir("kimchi-lsp-reset-")
		const project = makeTempDir("kimchi-lsp-reset-proj-") // sibling, outside the session cwd
		seedMarker(project, "pyproject.toml")
		const ext = makeSession()
		const ctx = await startSession(ext, sessionDir)

		await fireToolResult(ext, editToolResult(path.join(project, "main.py")), ctx)
		expect(activeTools(ext)).toContain("lsp_diagnostics")

		// A fresh session over the same scratch cwd (no markers within the
		// session-start scan's reach) hides the tools again.
		await startSession(ext, sessionDir)
		for (const name of LSP_TOOL_NAMES) {
			expect(activeTools(ext)).not.toContain(name)
		}
	})
})

describe("lazy activation — workspace relaxation for sessions started elsewhere", () => {
	/** Session in a bare scratch dir; the project lives in a SIBLING temp dir
	 *  (outside the session cwd) — the started-elsewhere geometry. */
	async function startedElsewhere() {
		const sessionDir = makeTempDir("kimchi-lsp-outside-")
		const project = makeTempDir("kimchi-lsp-outside-proj-")
		seedMarker(project, "pyproject.toml")
		const ext = makeSession()
		const ctx = await startSession(ext, sessionDir)
		return { sessionDir, project, ext, ctx }
	}

	it("syncs edits outside the session cwd but inside the activation root", async () => {
		const { project, ext, ctx } = await startedElsewhere()
		const mainPy = path.join(project, "main.py")

		await fireToolResult(ext, editToolResult(mainPy), ctx)

		// Activated despite the file being outside the session cwd…
		expect(activeTools(ext)).toContain("lsp_diagnostics")
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("lsp", "LSP: pyright")
		// …and the client is keyed at the activation root (findRoot's
		// session-cwd clamp cannot see outside-workspace markers).
		expect(mocks.getOrCreateClient).toHaveBeenCalledWith(expect.objectContaining({ name: "pyright" }), project)
		expect(mocks.refreshFile).toHaveBeenCalledWith(expect.anything(), mainPy)
	})

	it("lsp_* tools accept files inside the activation root and still reject everything outside both workspaces", async () => {
		const { project, ext, ctx } = await startedElsewhere()
		await fireToolResult(ext, editToolResult(path.join(project, "main.py")), ctx)
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)

		const hover = ext.getRegisteredTool("lsp_hover")
		// Inside the activation root (outside the session cwd): accepted,
		// client keyed at the activation root. (upstream pi 1.3: tool execute
		// receives an ExtensionToolContext — the lsp tools ignore it, but the
		// call must type-check.)
		const result = await hover.execute(
			"call-1",
			{ file_path: path.join(project, "main.py"), line: 0, character: 0 },
			undefined,
			undefined,
			createToolContext(),
		)
		expect(firstContentText(result)).not.toContain("outside the session workspace")
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(2)
		expect(mocks.getOrCreateClient).toHaveBeenLastCalledWith(expect.objectContaining({ name: "pyright" }), project)

		// Outside both the session cwd and the activation root: still the
		// stray-chain guard — refused without spawning anything.
		const elsewhere = makeTempDir("kimchi-lsp-unrelated-")
		const refused = await hover.execute(
			"call-2",
			{ file_path: path.join(elsewhere, "main.py"), line: 0, character: 0 },
			undefined,
			undefined,
			createToolContext(),
		)
		expect(firstContentText(refused)).toContain("outside the session workspace")
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(2)
	})

	it("edits outside both workspaces stay rejected after lazy activation (stray-chain guard intact)", async () => {
		const { project, ext, ctx } = await startedElsewhere()
		await fireToolResult(ext, editToolResult(path.join(project, "main.py")), ctx)
		expect(mocks.getOrCreateClient).toHaveBeenCalledTimes(1)
		const clientCalls = mocks.getOrCreateClient.mock.calls.length

		const elsewhere = makeTempDir("kimchi-lsp-stray-")
		seedMarker(elsewhere, "pyproject.toml")
		await fireToolResult(ext, editToolResult(path.join(elsewhere, "main.py")), ctx)

		// No second chain for the unrelated project: the measured
		// 1.4-2.9GB stray-spawn guard is relaxed only for the activation root.
		expect(mocks.getOrCreateClient.mock.calls.length).toBe(clientCalls)
	})

	it("keys sibling dirs inside and outside the session cwd to one chain when the project root lies above the cwd", async () => {
		// Session started in a SUBDIR of the project (cwd = project/src); the
		// marker materializes at the project root AFTER session start, so
		// neither the upward walk nor the downward scan of session-start
		// detection saw it.
		const project = makeTempDir("kimchi-lsp-above-cwd-")
		const sessionCwd = path.join(project, "src")
		fs.mkdirSync(sessionCwd, { recursive: true })
		const ext = makeSession()
		const ctx = await startSession(ext, sessionCwd)
		for (const name of LSP_TOOL_NAMES) {
			expect(activeTools(ext)).not.toContain(name)
		}

		seedMarker(project, "pyproject.toml")

		// A source file DEEP INSIDE the session cwd: detection walks past the
		// cwd up to the marker, and the client must key at the project root —
		// findRoot's session-cwd clamp would otherwise fall back to the file's
		// own directory and split the project across chains.
		const inCwdFile = path.join(sessionCwd, "pkg", "main.py")
		await fireToolResult(ext, writeToolResult(inCwdFile), ctx)
		expect(activeTools(ext)).toContain("lsp_diagnostics")
		expect(mocks.refreshFile).toHaveBeenCalledWith(expect.anything(), inCwdFile)

		// A sibling source dir OUTSIDE the session cwd but inside the same
		// project: same root, same chain.
		await fireToolResult(ext, writeToolResult(path.join(project, "tests", "main.py")), ctx)

		// Every client spawned for this session keys at the project root.
		expect(mocks.getOrCreateClient.mock.calls.length).toBeGreaterThan(0)
		for (const call of mocks.getOrCreateClient.mock.calls) {
			expect(call[1]).toBe(project)
		}
	})
})

describe("lazy activation — one-time activation steer (branch B)", () => {
	/** All sendMessage calls with the lsp_activation custom type. */
	function activationSteers(ext: ReturnType<typeof makeSession>) {
		return ext.sendMessage.mock.calls.filter((call) => call[0].customType === "lsp_activation")
	}

	it("pyright: sends exactly one steer with the supersession + fallback clauses and the root", async () => {
		const dir = makeTempDir("kimchi-lsp-steer-py-")
		const project = path.join(dir, "proj")
		const ext = makeSession()
		const ctx = await startSession(ext, dir)

		seedMarker(project, "pyproject.toml")
		await fireToolResult(ext, writeToolResult(path.join(project, "main.py")), ctx)

		// Exactly one activation steer — the single-winner stop bounds it; a
		// second .py touch must not re-send (activation already final).
		await fireToolResult(ext, writeToolResult(path.join(project, "other.py")), ctx)

		const steers = activationSteers(ext)
		expect(steers).toHaveLength(1)
		const [message, options] = steers[0]
		expect(message.display).toBe(false)
		expect(options).toEqual({ deliverAs: "steer" })
		expect(message.content).toContain("Language server pyright is now active")
		expect(message.content).toContain(project)
		expect(message.content).toContain("supersedes the earlier ast.parse post-edit validation")
		// Content-keyed fallback shapes, not "if it errors": the refusal is an
		// ordinary tool result.
		expect(message.content).toContain("If it reports no server available")
		expect(message.content).toContain('python3 -c "import ast..."')
	})

	it("gopls: sends the generic steer without the Python supersession clause", async () => {
		const dir = makeTempDir("kimchi-lsp-steer-go-")
		const project = path.join(dir, "goproj")
		binaries.available = ["gopls"]
		const ext = makeSession()
		const ctx = await startSession(ext, dir)

		seedMarker(project, "go.mod")
		await fireToolResult(ext, writeToolResult(path.join(project, "main.go")), ctx)

		const steers = activationSteers(ext)
		expect(steers).toHaveLength(1)
		const [message] = steers[0]
		expect(message.content).toContain("Language server gopls is now active")
		expect(message.content).toContain("lsp_diagnostics")
		expect(message.content).not.toContain("supersedes")
		expect(message.content).not.toContain("ast.parse")
	})

	it("session-start-active sessions send no activation steer", async () => {
		const dir = makeTempDir("kimchi-lsp-steer-start-")
		seedMarker(dir, "pyproject.toml")
		const ext = makeSession()
		const ctx = await startSession(ext, dir)
		expect(activeTools(ext)).toContain("lsp_diagnostics")

		// The session-start winner serves every subsequent file op — the lazy
		// path never runs, so no activation steer (the lsp-tools prompt block
		// has covered guidance from turn 0).
		await fireToolResult(ext, writeToolResult(path.join(dir, "main.py")), ctx)
		expect(activationSteers(ext)).toHaveLength(0)
	})

	it("the steer precedes the diagnostics of the same tool_result — both reach the model", async () => {
		// The materializing write also file-syncs and may steer diagnostics;
		// the activation steer is sent before that async sync work begins
		// (maybeActivateForPath runs first in the handler), so ordering within
		// the same turn is activation → diagnostics.
		const dir = makeTempDir("kimchi-lsp-steer-order-")
		const project = path.join(dir, "proj")
		binaries.available = ["pyright-langserver"]
		const ext = makeSession()
		const ctx = await startSession(ext, dir)

		seedMarker(project, "pyproject.toml")
		mocks.waitForDiagnostics.mockResolvedValue(true)
		const diagMap = new Map([
			[
				`file://${path.join(project, "main.py")}`,
				{ diagnostics: [{ range: { start: { line: 0, character: 0 } }, message: "err", severity: 1 }] },
			],
		])
		mocks.getOrCreateClient.mockResolvedValue({ diagnostics: diagMap })

		await fireToolResult(ext, writeToolResult(path.join(project, "main.py")), ctx)

		const calls = ext.sendMessage.mock.calls
		const activationIndex = calls.findIndex((call) => call[0].customType === "lsp_activation")
		const diagIndex = calls.findIndex((call) => call[0].customType === "lsp_diagnostics")
		expect(activationIndex).toBeGreaterThanOrEqual(0)
		expect(diagIndex).toBeGreaterThanOrEqual(0)
		expect(activationIndex).toBeLessThan(diagIndex)
	})
})
