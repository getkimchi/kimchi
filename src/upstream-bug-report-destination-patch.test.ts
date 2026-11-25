import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import JSZip from "jszip"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reportBug } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/bug-report.js"
import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
import { createModel, createModelRegistry } from "./extensions/__mocks__/model-registry.js"
import type { BugReportBundle, KimchiBugReportDelivery } from "./extensions/bug-report.js"

vi.mock("../node_modules/@earendil-works/pi-coding-agent/dist/core/crash-log.js", () => ({
	readCrashLog: () => [],
	clearCrashLog: () => {},
}))

type DeliveryHook = (bundle: BugReportBundle) => Promise<KimchiBugReportDelivery>
type ScrubHook = (bundle: BugReportBundle) => Promise<BugReportBundle>
type HarnessGlobal = typeof globalThis & {
	__kimchiBugReportDeliver?: DeliveryHook
	__kimchiBugReportScrub?: ScrubHook
}

const globals = globalThis as HarnessGlobal
let dir: string
let originalDeliver: DeliveryHook | undefined
let originalScrub: ScrubHook | undefined
let originalCwd: string

beforeEach(() => {
	initTheme("light")
	dir = mkdtempSync(join(tmpdir(), "bug-report-flow-"))
	originalCwd = process.cwd()
	process.chdir(dir)
	vi.stubEnv("PI_OFFLINE", "")
	originalDeliver = globals.__kimchiBugReportDeliver
	originalScrub = globals.__kimchiBugReportScrub
	globals.__kimchiBugReportDeliver = undefined
	globals.__kimchiBugReportScrub = undefined
})

afterEach(() => {
	process.chdir(originalCwd)
	vi.unstubAllEnvs()
	globals.__kimchiBugReportDeliver = originalDeliver
	globals.__kimchiBugReportScrub = originalScrub
	rmSync(dir, { recursive: true, force: true })
})

function makeContext(deliverLabel: "File on GitHub" | "Export as Zip") {
	const statuses: string[] = []
	const errors: string[] = []
	const prompts: string[] = []
	const inputSequence = deliverLabel === "Export as Zip" ? ["\r", "2", "2", "2"] : ["\r", "2", "2", "1"]
	const settingsManager = {
		getGlobalSettings: () => ({}),
		getProjectSettings: () => ({}),
		getExternalEditorCommand: () => undefined,
	}
	const manager = {
		getCwd: () => dir,
		getSessionId: () => "bug-session",
		getEntries: () => [],
		appendCustomEntry: vi.fn(),
	}
	const model = createModel("test-model", "test-provider")
	const session = {
		sessionId: "bug-session",
		messages: [],
		model,
		modelRuntime: createModelRegistry([model]),
		settingsManager,
		resourceLoader: { getExtensions: () => ({ extensions: [], errors: [] }) },
		sessionManager: manager,
	}
	let step = 0
	const editor = { focused: true, handleInput: vi.fn() }
	const drive = (component: unknown) => {
		if (component === editor) return
		if (
			typeof component !== "object" ||
			component === null ||
			!("handleInput" in component) ||
			!("render" in component)
		) {
			throw new Error("report component is not input-capable")
		}
		if ("focused" in component) (component as { focused: boolean }).focused = true
		const { handleInput, render } = component as {
			handleInput: (keyData: string) => void
			render: (width: number) => string[]
		}
		prompts.push(render.call(component, 120).join("\n"))
		queueMicrotask(() => {
			if (step < inputSequence.length) handleInput.call(component, inputSequence[step++])
		})
	}
	const context = {
		session,
		ui: { setFocus: drive, requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } },
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		editor,
		keybindings: {
			matches: (data: string, action: string) => {
				if (action === "tui.select.cancel") return data === "\x1b"
				if (action === "tui.select.confirm") return data === "\r" || data === "\n"
				if (action === "tui.select.down") return data === "\x1b[B" || data === "j"
				if (action === "tui.select.up") return data === "\x1b[A" || data === "k"
				return false
			},
		},
		showStatus: (message: string) => statuses.push(message),
		showError: (message: string) => errors.push(message),
	} as unknown as Parameters<typeof reportBug>[0]
	return {
		context: context as Parameters<typeof reportBug>[0],
		prompts,
		statuses,
		errors,
		manager,
	}
}

async function exportedZip(): Promise<JSZip> {
	const archive = readdirSync(dir, { encoding: "utf8" }).find((name) => name.endsWith(".zip"))
	if (!archive) throw new Error("no zip archive produced")
	return JSZip.loadAsync(readFileSync(join(dir, archive)))
}

describe("/bug destination behavior", () => {
	it("preserves the stock disclaimer and exports a real archive without a destination hook", async () => {
		const harness = makeContext("Export as Zip")
		await reportBug(harness.context)

		expect(harness.prompts[0]).toContain("This report goes to the Pi developers (Earendil)")
		const archive = await exportedZip()
		const metadataFile = archive.file("report.json")
		if (!metadataFile) throw new Error("archive is missing report.json")
		expect(JSON.parse(await metadataFile.async("string")).session).toMatchObject({
			id: "bug-session",
			included: false,
		})
		expect(harness.errors).toEqual([])
		expect(harness.statuses[0]).toContain("Bug report exported to:")
	})

	it("selects the Kimchi disclaimer after a late destination hook is installed and private-gist upload", async () => {
		const harness = makeContext("File on GitHub")
		const deliver = vi.fn(async () => ({ message: "Bug report filed." }))
		globals.__kimchiBugReportDeliver = deliver

		await reportBug(harness.context)

		expect(harness.prompts[0]).toContain("getkimchi/kimchi")
		const delivery = harness.prompts.find((prompt) => prompt.includes("Bug report"))
		expect(delivery).toContain("private GitHub gist")
		expect(delivery).toContain("github.com/getkimchi/kimchi")
		expect(deliver).toHaveBeenCalledOnce()
		expect(harness.statuses).toContain("Bug report filed.")
	})

	it("scrubs the actual bundle before private delivery", async () => {
		const harness = makeContext("File on GitHub")
		const deliver = vi.fn(async () => ({ message: "filed" }))
		globals.__kimchiBugReportDeliver = deliver
		globals.__kimchiBugReportScrub = vi.fn(async (bundle: BugReportBundle) => ({
			...bundle,
			metadata: { ...bundle.metadata, scrubbed: true },
		}))

		await reportBug(harness.context)

		expect(globals.__kimchiBugReportScrub).toHaveBeenCalledOnce()
		expect(deliver).toHaveBeenCalledOnce()
		expect(deliver).toHaveBeenCalledWith(
			expect.objectContaining({ metadata: expect.objectContaining({ scrubbed: true }) }),
		)
	})
})
