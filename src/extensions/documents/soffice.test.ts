import { describe, expect, it } from "vitest"
import { findSoffice, libreOfficeInstallHint, sofficeCandidates } from "./soffice.js"

const FEATURE = { format: "pdf" as const, commands: "edit-draw/dump-shapes", core: "read/create" }

function deps(opts: {
	platform: NodeJS.Platform
	onPath?: string
	exists?: string[]
	env?: Record<string, string | undefined>
	opt?: string[]
}) {
	const exists = new Set((opts.exists ?? []).map((p) => p.replace(/\\/g, "/")))
	return {
		which: (cmd: string) => (cmd === "soffice" ? opts.onPath : undefined),
		// Production builds candidates with `join` — backslashes on Windows.
		fileExists: (p: string) => exists.has(p.replace(/\\/g, "/")),
		env: opts.env ?? {},
		platform: opts.platform,
		home: "/home/u",
		listdir: (dir: string) => {
			if (dir !== "/opt") throw new Error("ENOENT")
			return opts.opt ?? []
		},
	}
}

describe("findSoffice", () => {
	it("prefers KIMCHI_SOFFICE over PATH", () => {
		const d = deps({
			platform: "linux",
			onPath: "/usr/bin/soffice",
			exists: ["/x/soffice"],
			env: { KIMCHI_SOFFICE: "/x/soffice" },
		})
		expect(findSoffice(d, FEATURE)).toBe("/x/soffice")
	})

	it("fails loudly when KIMCHI_SOFFICE points nowhere instead of silently falling back", () => {
		const d = deps({ platform: "linux", onPath: "/usr/bin/soffice", env: { KIMCHI_SOFFICE: "/missing" } })
		expect(() => findSoffice(d, FEATURE)).toThrow(/KIMCHI_SOFFICE points at \/missing/)
	})

	it("uses PATH before install locations", () => {
		const d = deps({ platform: "darwin", onPath: "/opt/homebrew/bin/soffice" })
		expect(findSoffice(d, FEATURE)).toBe("/opt/homebrew/bin/soffice")
	})

	it("finds the per-user macOS app bundle when soffice is not on PATH", () => {
		const bundle = "/home/u/Applications/LibreOffice.app/Contents/MacOS/soffice"
		// Candidates are built with `join` — backslashes on Windows. Normalize.
		expect(findSoffice(deps({ platform: "darwin", exists: [bundle] }), FEATURE).replace(/\\/g, "/")).toBe(bundle)
	})

	it("prefers soffice.com over soffice.exe on Windows", () => {
		const com = "C:\\Program Files\\LibreOffice\\program\\soffice.com"
		const exe = "C:\\Program Files\\LibreOffice\\program\\soffice.exe"
		expect(findSoffice(deps({ platform: "win32", exists: [exe, com] }), FEATURE)).toBe(com)
	})

	it("finds an /opt/libreoffice* install on Linux and ignores other /opt entries", () => {
		const d = deps({
			platform: "linux",
			opt: ["other", "libreoffice24.8"],
			exists: ["/opt/other/program/soffice", "/opt/libreoffice24.8/program/soffice"],
		})
		expect(findSoffice(d, FEATURE)).toBe("/opt/libreoffice24.8/program/soffice")
	})

	it("throws tool-missing with the per-OS install command and the core commands", () => {
		for (const [platform, cmd] of [
			["darwin", "brew install --cask libreoffice"],
			["win32", "winget install TheDocumentFoundation.LibreOffice"],
			["linux", "apt install libreoffice"],
		] as const) {
			let err: unknown
			try {
				findSoffice(deps({ platform }), FEATURE)
			} catch (e) {
				err = e
			}
			expect(err).toMatchObject({ code: "tool-missing" })
			const msg = (err as Error).message
			expect(msg).toContain(cmd)
			expect(msg).toContain("KIMCHI_SOFFICE")
			expect(msg).toContain("read/create never need it")
		}
	})
})

describe("sofficeCandidates", () => {
	it("survives a missing /opt", () => {
		const list = sofficeCandidates("linux", {}, "/home/u", () => {
			throw new Error("ENOENT")
		})
		expect(list).toContain("/usr/lib/libreoffice/program/soffice")
	})

	it("honours a non-default ProgramFiles", () => {
		const list = sofficeCandidates("win32", { ProgramFiles: "D:\\Apps" }, "C:\\Users\\u", () => [])
		expect(list[0]).toBe("D:\\Apps\\LibreOffice\\program\\soffice.com")
	})

	it("install hint names one command for the current OS", () => {
		expect(libreOfficeInstallHint("darwin")).not.toContain("winget")
	})
})
