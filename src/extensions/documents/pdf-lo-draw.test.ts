import { describe, expect, it } from "vitest"
import { type LoDrawDeps, runLoDraw } from "./pdf-lo-draw.js"

const SCRIPT_URL = "vnd.sun.star.script:lodraw_edit.py$main?language=Python&location=user"

interface RunResult {
	code: number
	stderr?: string
	signal?: NodeJS.Signals
}

interface FakeState {
	files: Set<string>
	removed: string[]
	runs: Array<{ cmd: string; args: string[]; env: Record<string, string> }>
	profileDirs: string[]
	written: string[]
	/** Overrides for behavior. */
	run?: (cmd: string, args: string[], env: Record<string, string>) => RunResult
	onMkdtemp?: (prefix: string) => string
	/** Status JSON the emulated macro writes. */
	statusPayload?: unknown
	/** When set, the emulated macro reports ok but skips writing the output. */
	omitOutput?: boolean
}

function fakeDeps(state: FakeState, scriptDir = "/skills/pdf/scripts"): LoDrawDeps {
	return {
		which: (cmd) => (cmd === "soffice" ? "/usr/bin/soffice" : undefined),
		fileExists: (p) => state.files.has(p) || p === `${scriptDir}/lodraw_edit.py`,
		run: (cmd, args, env) => {
			state.runs.push({ cmd, args, env })
			// Emulate the macro: status lands at env.LO_STATUS; output at LO_OUT
			// unless the test asks to omit it.
			const status = state.run?.(cmd, args, env) ?? { code: 0 }
			if (env.LO_MODE === "dump" || (status.code === 0 && !state.omitOutput)) state.files.add(env.LO_OUT)
			state.files.add(env.LO_STATUS)
			return { code: status.code ?? 0, stderr: status.stderr ?? "", signal: status.signal }
		},
		mkdtemp: (prefix) => {
			const dir = state.onMkdtemp ? state.onMkdtemp(prefix) : `${prefix}p1`
			state.profileDirs.push(dir)
			return dir
		},
		readFile: (p) => {
			if (p === `${scriptDir}/lodraw_edit.py`) return "# fake macro"
			if (!state.files.has(p)) throw new Error(`ENOENT: ${p}`)
			return p.endsWith("lo-status.json")
				? JSON.stringify(state.statusPayload ?? { ok: true, pages: 3, applied: 1 })
				: "{}"
		},
		writeFile: (p) => {
			state.written.push(p)
		},
		rmdir: (dir) => {
			state.removed.push(dir)
		},
		unlink: (p) => {
			state.removed.push(p)
		},
		scriptDir,
	}
}

describe("runLoDraw", () => {
	it("runs soffice headless on a staged profile with the macro URL and env contract", async () => {
		const state: FakeState = { files: new Set(["/work/in.pdf"]), removed: [], runs: [], profileDirs: [], written: [] }
		await runLoDraw("apply", "/work/in.pdf", "/work/out.pdf", fakeDeps(state), "/work/map.json")
		const run = state.runs[0]
		expect(run.cmd).toBe("/usr/bin/soffice")
		expect(run.args).toContain("--headless")
		expect(run.args).toContain("--nolockcheck")
		expect(run.args.some((a) => a.startsWith("-env:UserInstallation=file://"))).toBe(true)
		expect(run.args).toContain(SCRIPT_URL)
		expect(run.env.LO_MODE).toBe("apply")
		expect(run.env.LO_PDF).toBe("/work/in.pdf")
		expect(run.env.LO_OUT).toBe("/work/out.pdf")
		expect(run.env.LO_MAP).toBe("/work/map.json")
		// The macro script is staged into the throwaway profile.
		const profile = state.profileDirs[0]
		expect(state.written).toContain(`${profile}/user/Scripts/python/lodraw_edit.py`)
	})

	it("removes a stale profile lock before running and cleans the profile after", async () => {
		const state: FakeState = { files: new Set(["/work/in.pdf"]), removed: [], runs: [], profileDirs: [], written: [] }
		const deps = fakeDeps(state)
		// Seed the stale lock: the fake must know it exists on whatever profile
		// path mkdtemp hands out (known only after staging).
		const baseFileExists = deps.fileExists ?? (() => false)
		deps.fileExists = (p) => baseFileExists(p) || (p.endsWith("/.lock") && p.includes("pdf-lo-profile"))
		await runLoDraw("dump", "/work/in.pdf", "/work/dump.json", deps)
		expect(state.removed.some((p) => p.endsWith("/.lock"))).toBe(true)
		expect(state.removed).toContain(state.profileDirs[0])
	})

	it("throws tool-missing naming LibreOffice when soffice is nowhere", async () => {
		const deps = fakeDeps({ files: new Set(), removed: [], runs: [], profileDirs: [], written: [] })
		deps.which = () => undefined
		deps.fileExists = () => false
		await expect(runLoDraw("dump", "/work/in.pdf", "/work/out.json", deps)).rejects.toMatchObject({
			code: "tool-missing",
			message: expect.stringContaining("LibreOffice"),
		})
	})

	it("reports the macro's error status as corrupt", async () => {
		const state: FakeState = {
			files: new Set(["/work/in.pdf"]),
			removed: [],
			runs: [],
			profileDirs: [],
			written: [],
			statusPayload: { ok: false, error: "load failed" },
		}
		await expect(runLoDraw("apply", "/work/in.pdf", "/work/out.pdf", fakeDeps(state))).rejects.toMatchObject({
			code: "corrupt",
			message: expect.stringContaining("load failed"),
		})
	})

	it("maps a signal-killed soffice run to a timeout error", async () => {
		const state: FakeState = {
			files: new Set(["/work/in.pdf"]),
			written: [],
			removed: [],
			runs: [],
			profileDirs: [],
			run: () => ({ code: 1, signal: "SIGTERM" }),
		}
		await expect(runLoDraw("dump", "/work/in.pdf", "/work/dump.json", fakeDeps(state))).rejects.toMatchObject({
			code: "timeout",
		})
	})

	it("fails when soffice reports success but writes no output", async () => {
		const state: FakeState = {
			files: new Set(["/work/in.pdf"]),
			removed: [],
			runs: [],
			profileDirs: [],
			written: [],
			omitOutput: true,
		}
		// Emulate a macro that reports ok but never creates the output file.
		state.run = (_cmd, _args, env) => {
			state.files.add(env.LO_STATUS)
			return { code: 0 }
		}
		await expect(runLoDraw("apply", "/work/in.pdf", "/work/out.pdf", fakeDeps(state))).rejects.toMatchObject({
			code: "corrupt",
			message: expect.stringContaining("produced no file"),
		})
	})

	it("errors when lodraw_edit.py is missing everywhere", async () => {
		const deps = fakeDeps({ files: new Set(["/work/in.pdf"]), removed: [], runs: [], profileDirs: [], written: [] })
		deps.scriptDir = "/nowhere"
		deps.fileExists = (p) => p === "/work/in.pdf"
		await expect(runLoDraw("dump", "/work/in.pdf", "/work/dump.json", deps)).rejects.toMatchObject({
			code: "corrupt",
			message: expect.stringContaining("lodraw_edit.py not found"),
		})
	})
})
