import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { findBrowser, htmlToPdf } from "./browser.js"

function deps(opts: {
	platform: NodeJS.Platform
	onPath?: Record<string, string>
	exists?: string[]
	env?: Record<string, string | undefined>
}) {
	const exists = new Set(opts.exists ?? [])
	return {
		which: (cmd: string) => opts.onPath?.[cmd],
		fileExists: (p: string) => exists.has(p),
		run: () => ({ code: 0, stderr: "" }),
		env: opts.env ?? {},
		platform: opts.platform,
		home: "/home/u",
		mkdtemp: () => "/tmp/fake-profile",
		rmdir: () => undefined,
	}
}

describe("findBrowser", () => {
	it("prefers KIMCHI_BROWSER over everything", () => {
		const d = deps({
			platform: "linux",
			onPath: { chromium: "/usr/bin/chromium" },
			exists: ["/opt/my-chrome"],
			env: { KIMCHI_BROWSER: "/opt/my-chrome" },
		})
		expect(findBrowser(d)).toMatchObject({ cmd: "/opt/my-chrome" })
	})

	it("fails loudly when KIMCHI_BROWSER points nowhere instead of silently falling back", () => {
		const d = deps({ platform: "linux", env: { KIMCHI_BROWSER: "/missing" } })
		expect(() => findBrowser(d)).toThrow(/KIMCHI_BROWSER points at \/missing/)
	})

	it("finds a PATH binary first", () => {
		expect(findBrowser(deps({ platform: "linux", onPath: { chromium: "/usr/bin/chromium" } }))).toMatchObject({
			cmd: "/usr/bin/chromium",
			label: "chromium",
		})
	})

	it("labels the macOS app bundle by browser, not by path", () => {
		const edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
		expect(findBrowser(deps({ platform: "darwin", exists: [edge] }))).toMatchObject({ label: "Microsoft Edge" })
		const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
		expect(findBrowser(deps({ platform: "darwin", exists: [chrome] }))).toMatchObject({ label: "Google Chrome" })
	})

	it("tries Edge before Chrome on Windows (Edge ships with the OS)", () => {
		const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
		const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
		const d = deps({
			platform: "win32",
			exists: [chrome, edge],
			env: { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
		})
		expect(findBrowser(d).cmd).toBe(edge)
	})

	it("is tool-missing with install hint and core fallback when no browser exists", () => {
		let err: Error | undefined
		try {
			findBrowser(deps({ platform: "darwin" }))
		} catch (e) {
			err = e as Error
		}
		expect(err).toMatchObject({ code: "tool-missing" })
		expect(err?.message).toContain("Google Chrome, Chromium, or Microsoft Edge")
		expect(err?.message).toContain("KIMCHI_BROWSER")
		expect(err?.message).toContain("create (plain styling) never needs it")
	})
})

describe("htmlToPdf", () => {
	it("runs headless with a throwaway profile, no-network resolver rule, and the file URL", () => {
		const printed: string[] = []
		const removed: string[] = []
		const d = deps({ platform: "linux", onPath: { chromium: "/usr/bin/chromium" } })
		const io = {
			...d,
			run: (_cmd: string, args: string[]) => {
				printed.push(...args)
				return { code: 0, stderr: "" }
			},
			mkdtemp: () => "/tmp/fake-profile",
			rmdir: (dir: string) => removed.push(dir),
			// htmlToPdf checks the output exists after the run
			fileExists: (p: string) => p === "/tmp/out.pdf",
		}
		const browser = htmlToPdf("/home/u/doc.html", "/tmp/out.pdf", io)
		expect(browser.label).toBe("chromium")
		const argv = printed.join(" ")
		expect(argv).toContain("--headless")
		expect(argv).toContain("--host-resolver-rules=MAP * ~NOTFOUND")
		expect(argv).toContain("--user-data-dir=/tmp/fake-profile")
		expect(argv).toContain("--print-to-pdf=/tmp/out.pdf")
		expect(argv).toContain(pathToFileURL("/home/u/doc.html").href)
		expect(removed).toEqual(["/tmp/fake-profile"])
	})

	it("maps the timeout signal to a typed error", () => {
		const d = deps({ platform: "linux", onPath: { chromium: "/usr/bin/chromium" } })
		let err: Error | undefined
		try {
			htmlToPdf("/home/u/doc.html", "/tmp/out.pdf", {
				...d,
				run: () => ({ code: 0, stderr: "", signal: "SIGTERM" }),
				fileExists: () => false,
			})
		} catch (e) {
			err = e as Error
		}
		expect(err).toMatchObject({ code: "timeout" })
	})

	it("reports a non-zero browser exit with its stderr excerpt", () => {
		const d = deps({ platform: "linux", onPath: { chromium: "/usr/bin/chromium" } })
		let err: Error | undefined
		try {
			htmlToPdf("/home/u/doc.html", "/tmp/out.pdf", {
				...d,
				run: () => ({ code: 1, stderr: "boom\nline2\nline3\nline4" }),
				fileExists: () => false,
			})
		} catch (e) {
			err = e as Error
		}
		expect(err).toMatchObject({ code: "corrupt" })
		expect(err?.message).toContain("exited 1")
		expect(err?.message).toContain("boom")
	})
})
