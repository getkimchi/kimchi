import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ARTIFACT_EXTENSIONS, artifactsFromToolCall } from "./detect.js"

let cwd: string

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "acp-artifacts-"))
})

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true })
})

function touch(rel: string): string {
	const abs = join(cwd, rel)
	mkdirSync(join(abs, ".."), { recursive: true })
	writeFileSync(abs, "x")
	return abs
}

function textResult(text: string, isError = false) {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }
}

describe("artifactsFromToolCall", () => {
	it("keeps the bash sniff regex in sync with ARTIFACT_EXTENSIONS", () => {
		// PATH_TOKEN inlines the extension list (regex literal); every
		// allowlisted extension must be detectable BOTH from bash output (regex)
		// and from write/edit args (map lookup) — a drift in either list
		// silently disables one path.
		for (const ext of Object.keys(ARTIFACT_EXTENSIONS)) {
			// Sniffed from output text: exists on disk with a fresh mtime.
			touch(`f${ext}`)
			expect(
				artifactsFromToolCall("bash", {}, textResult(`wrote f${ext}`), cwd, { windowStart: Date.now() - 1000 }).map(
					(a) => a.name,
				),
				`bash sniff of f${ext}`,
			).toEqual([`f${ext}`])
			const abs = touch(`w${ext}`)
			expect(
				artifactsFromToolCall("write", { path: `w${ext}` }, textResult("ok"), cwd).map((a) => a.path),
				`write detection of w${ext}`,
			).toEqual([abs])
		}
	})

	it("detects a write to an allowlisted extension", () => {
		const abs = touch("slides.pptx")
		const out = artifactsFromToolCall("write", { path: "slides.pptx" }, textResult("ok"), cwd)
		expect(out).toEqual([
			{
				path: abs,
				name: "slides.pptx",
				uri: pathToFileURL(abs).href,
				mimeType: expect.stringContaining("presentationml"),
				origin: "write",
			},
		])
	})

	it("ignores write/edit paths outside the allowlist", () => {
		touch("notes.txt")
		expect(artifactsFromToolCall("write", { path: "notes.txt" }, textResult("ok"), cwd)).toEqual([])
		expect(artifactsFromToolCall("edit", { path: "notes.txt" }, textResult("ok"), cwd)).toEqual([])
	})

	it("detects an edit to an allowlisted extension", () => {
		const abs = touch("report.pdf")
		const out = artifactsFromToolCall("edit", { path: abs }, textResult("ok"), cwd)
		expect(out.map((a) => a.path)).toEqual([abs])
	})

	it("returns nothing for write without a string path", () => {
		expect(artifactsFromToolCall("write", {}, textResult("ok"), cwd)).toEqual([])
		expect(artifactsFromToolCall("write", { path: 42 }, textResult("ok"), cwd)).toEqual([])
	})

	it("detects a path mentioned in bash output", () => {
		const abs = touch("out/deck.pptx")
		const out = artifactsFromToolCall("bash", { command: "python make.py" }, textResult(`saved to ${abs}\n`), cwd)
		expect(out.map((a) => a.path)).toEqual([abs])
	})

	it("detects cwd-relative paths in bash output", () => {
		const abs = touch("out/deck.pptx")
		const out = artifactsFromToolCall("bash", {}, textResult("wrote out/deck.pptx"), cwd)
		expect(out.map((a) => a.path)).toEqual([abs])
	})

	it("handles quoted paths and trailing punctuation", () => {
		const abs = touch("chart.png")
		const out = artifactsFromToolCall("bash", {}, textResult('generated "chart.png", done.'), cwd)
		expect(out.map((a) => a.path)).toEqual([abs])
	})

	it("strips paren/bracket delimiters around paths", () => {
		const abs = touch("out.pdf")
		const results = touch("results.pdf")
		const out = artifactsFromToolCall("bash", {}, textResult("wrote report (out.pdf)"), cwd)
		expect(out.map((a) => a.path)).toEqual([abs])
		const md = artifactsFromToolCall("bash", {}, textResult(`see [results.pdf](file://x)`), cwd)
		expect(md.map((a) => a.path)).toEqual([results])
		// Nonexistent tokens drop out at the stat gate regardless of delimiters.
		expect(artifactsFromToolCall("bash", {}, textResult("wrote (docs/ghost.pdf)"), cwd)).toEqual([])
	})

	it("a repeated token does not starve the candidate budget", () => {
		touch("late.pdf")
		const noise = Array.from({ length: 500 }, () => "spam.pdf").join(" ")
		const out = artifactsFromToolCall("bash", {}, textResult(`${noise} late.pdf`), cwd)
		expect(out.map((a) => a.name)).toEqual(["late.pdf"])
	})

	it("rejects URL candidates and detects powershell output", () => {
		expect(artifactsFromToolCall("bash", {}, textResult("downloaded https://example.com/file.pdf"), cwd)).toEqual([])
		const abs = touch("ps-report.csv")
		const ps = artifactsFromToolCall("powershell", {}, textResult(`Export-Csv ${abs}`), cwd)
		expect(ps.map((a) => a.path)).toEqual([abs])
	})

	it("detects multiple distinct artifacts and dedupes repeats", () => {
		const a = touch("a.pdf")
		const b = touch("b.xlsx")
		const out = artifactsFromToolCall("bash", {}, textResult(`${a}\n${b}\n${a}\n`), cwd)
		expect(out.map((x) => x.path)).toEqual([a, b])
	})

	it("filters candidates that do not exist on disk (live mode)", () => {
		const out = artifactsFromToolCall("bash", {}, textResult("saved to ghost.pptx"), cwd)
		expect(out).toEqual([])
	})

	it("ignores comma/backslash/dollar shapes (data rows, escapes, shell vars) even without a stat gate", () => {
		for (const text of ["monday,grumpy,report.csv shipped", "wrote $OUT.md", "copied foo\\ bar.md done"]) {
			const out = artifactsFromToolCall("bash", {}, textResult(text), cwd)
			expect(out).toHaveLength(0)
		}
	})

	it("chips the redirect target and not a CSV content line naming another file", () => {
		const target = touch("echo-baby-2.csv")
		const result = textResult("day,mood,evidence\nwednesday,elated,echo-baby.csv shipped in prod\n")
		const args = { command: `echo x > ${target} && cat ${target}` }
		const out = artifactsFromToolCall("bash", args, result, cwd, { windowStart: Date.now() - 1000 })
		expect(out.map((a) => a.name)).toEqual(["echo-baby-2.csv"])
	})

	it("returns nothing for errored results", () => {
		touch("slides.pptx")
		expect(artifactsFromToolCall("write", { path: "slides.pptx" }, textResult("boom", true), cwd)).toEqual([])
		expect(artifactsFromToolCall("bash", {}, textResult("saved slides.pptx", true), cwd)).toEqual([])
	})

	it("returns nothing for read-only tools", () => {
		const abs = touch("a.pdf")
		expect(artifactsFromToolCall("read", { path: abs }, textResult(abs), cwd)).toEqual([])
	})

	it("caps bash artifacts per call", () => {
		const names = Array.from({ length: 12 }, (_, i) => `f${i}.pdf`)
		for (const n of names) touch(n)
		const out = artifactsFromToolCall("bash", {}, textResult(names.join("\n")), cwd)
		expect(out.length).toBe(8)
	})

	it("caps candidate evaluations per result so pathological output can't stall the scan", () => {
		const noise = Array.from({ length: 5000 }, (_, i) => `missing${i}.pdf`).join(" ")
		expect(artifactsFromToolCall("bash", {}, textResult(noise), cwd)).toEqual([])
		// A real file mentioned first lands well under the candidate cap.
		touch("real.pdf")
		const out = artifactsFromToolCall("bash", {}, textResult(`real.pdf ${noise}`), cwd)
		expect(out.map((a) => a.name)).toEqual(["real.pdf"])
	})

	it("never throws on malformed inputs", () => {
		expect(artifactsFromToolCall("bash", null, undefined, cwd)).toEqual([])
		expect(artifactsFromToolCall("bash", {}, { content: "not-an-array" }, cwd)).toEqual([])
		expect(artifactsFromToolCall("write", { path: `${String.fromCharCode(0)}.pdf` }, textResult("ok"), cwd)).toEqual([])
	})

	describe("tool-declared artifacts", () => {
		const declared = (...entries: unknown[]) => ({
			content: [{ type: "text", text: "Plan submitted." }],
			details: { artifacts: entries },
		})

		it("detects declared locations regardless of toolName", () => {
			// submit_plan writeFileSyncs .kimchi/plans/<slug>.md inside its
			// execute (the write tool never runs) and declares the location.
			const abs = touch("plan.md")
			const out = artifactsFromToolCall("submit_plan", { plan: "# Plan" }, declared({ path: abs }), cwd)
			expect(out.map((a) => a.path)).toEqual([abs])
		})

		it("detects multiple locations; optional name overrides the basename", () => {
			const a = touch("a.md")
			const b = touch("b.pdf")
			const out = artifactsFromToolCall("submit_plan", {}, declared({ path: a }, { path: b, name: "Deck" }), cwd)
			expect(out.map((x) => [x.path, x.name])).toEqual([
				[a, "a.md"],
				[b, "Deck"],
			])
		})

		it("declared paths are authoritative (no mtime window); missing file is still dropped live", () => {
			const abs = touch("plan.md")
			const past = Date.now() - 60_000
			utimesSync(abs, new Date(past), new Date(past))
			expect(
				artifactsFromToolCall("submit_plan", {}, declared({ path: abs }), cwd, { windowStart: Date.now() }).map(
					(a) => a.path,
				),
			).toEqual([abs])
			expect(artifactsFromToolCall("submit_plan", {}, declared({ path: join(cwd, "gone.md") }), cwd)).toEqual([])
		})

		it("caps declared entries (MAX_DECLARED_ARTIFACTS)", () => {
			const entries = Array.from({ length: 40 }, (_, i) => ({ path: touch(`d${i}.md`) }))
			const out = artifactsFromToolCall("submit_plan", {}, declared(...entries), cwd)
			expect(out).toHaveLength(32)
		})

		it("skips malformed entries but keeps valid ones", () => {
			const abs = touch("plan.md")
			const out = artifactsFromToolCall(
				"submit_plan",
				{},
				declared("not-an-object", { path: 42 }, { path: "" }, null, { path: abs }),
				cwd,
			)
			expect(out.map((a) => a.path)).toEqual([abs])
		})
	})

	it("submit_plan without details.artifacts produces nothing", () => {
		const abs = touch("plan.md")
		const out = artifactsFromToolCall(
			"submit_plan",
			{ plan: "# Plan" },
			textResult(`Plan submitted and saved to ${abs}.`),
			cwd,
		)
		expect(out).toEqual([])
	})

	it("detects bash redirect targets printed nowhere in the output", () => {
		const abs = touch("echo-baby.csv")
		// The path only appears in args.command (`> ...`), not in the cat output.
		const out = artifactsFromToolCall(
			"bash",
			{ command: `echo "a,b" > ${abs} && cat ${abs}` },
			textResult("a,b"),
			cwd,
			{ windowStart: Date.now() - 1000 },
		)
		expect(out.map((a) => a.path)).toEqual([abs])
	})

	it("excludes stderr redirects and non-allowlisted or stale redirect targets", () => {
		const csv = touch("out.csv")
		const past = Date.now() - 60_000
		utimesSync(csv, new Date(past), new Date(past)) // stale: window rejects
		const fresh = touch("fresh.csv")
		const windowStart = Date.now() - 1000
		expect(
			artifactsFromToolCall("bash", { command: `cmd 2>${join(cwd, "log.md")} > ${fresh}` }, textResult(""), cwd, {
				windowStart,
			}).map((a) => a.path),
		).toEqual([fresh])
		expect(artifactsFromToolCall("bash", { command: `echo x > ${csv}` }, textResult(""), cwd, { windowStart })).toEqual(
			[],
		)
	})

	it("dedupes when the redirect target is also printed in the output", () => {
		const abs = touch("report.md")
		const out = artifactsFromToolCall(
			"bash",
			{ command: `gen > ${abs} && echo wrote ${abs}` },
			textResult(`wrote ${abs}`),
			cwd,
			{ windowStart: Date.now() - 1000 },
		)
		expect(out).toHaveLength(1)
	})

	it("bare extension mentions are not candidates (empty path prefix)", () => {
		// "wrote a .md file" — `.md` alone has no path to resolve and would
		// otherwise produce file://<cwd>/.md on replay (no stat gate).
		expect(
			artifactsFromToolCall("bash", {}, textResult("wrote a .md file"), cwd, { windowStart: Date.now() - 1000 }),
		).toEqual([])
	})

	describe("mtime window and command filtering", () => {
		it("rejects a pre-existing file mentioned by a read-only command", () => {
			const abs = touch("notes.md")
			const past = Date.now() - 60_000
			utimesSync(abs, new Date(past), new Date(past))
			const out = artifactsFromToolCall("bash", { command: "cat notes.md" }, textResult("notes.md"), cwd, {
				windowStart: Date.now(),
			})
			expect(out).toEqual([])
		})

		it("accepts a file rewritten inside the window", () => {
			// Pre-existing file with an old mtime, then the tool rewrites it.
			const abs = touch("report.pdf")
			const past = Date.now() - 60_000
			utimesSync(abs, new Date(past), new Date(past))
			const windowStart = Date.now()
			touch("report.pdf")
			const out = artifactsFromToolCall(
				"bash",
				{ command: "pandoc in.md -o report.pdf" },
				textResult("wrote report.pdf"),
				cwd,
				{ windowStart },
			)
			expect(out.map((a) => a.path)).toEqual([abs])
		})

		it("tolerates coarse (1s+) mtime granularity, rejects clearly stale files", () => {
			const abs = touch("slides.pptx")
			const windowStart = Date.now()
			// Within tolerance: a write just before a coarse clock would round.
			utimesSync(abs, new Date(windowStart - 1_500), new Date(windowStart - 1_500))
			expect(
				artifactsFromToolCall("bash", {}, textResult("slides.pptx"), cwd, { windowStart }).map((a) => a.path),
			).toEqual([abs])
			// Outside tolerance: genuinely before the command started.
			utimesSync(abs, new Date(windowStart - 3_000), new Date(windowStart - 3_000))
			expect(artifactsFromToolCall("bash", {}, textResult("slides.pptx"), cwd, { windowStart })).toEqual([])
		})

		it("does not apply the window to write/edit paths (the tool authored them)", () => {
			const abs = touch("deck.pptx")
			const past = Date.now() - 60_000
			utimesSync(abs, new Date(past), new Date(past))
			const out = artifactsFromToolCall("write", { path: "deck.pptx" }, textResult("ok"), cwd, {
				windowStart: Date.now(),
			})
			expect(out.map((a) => a.path)).toEqual([abs])
		})

		it("skips sniffing for tree-materializing git commands", () => {
			const abs = touch("restored.md")
			for (const command of [
				"git checkout main",
				"git -C repo merge feature",
				"git stash pop",
				"git pull && git status",
				"sudo git pull",
				"sudo -u root git pull",
				// sudo -n takes no argument; nice -n takes one. Same flag, per-wrapper handling.
				"sudo -n git pull",
				"nice -n 5 git merge feature",
				"env LANG=C sudo -u root git rebase main",
				"env GIT_TRACE=1 git merge feature",
				"/usr/bin/git checkout main",
				"git.exe pull",
				"doas -u root git pull",
				"nohup git pull",
				"setsid -w git merge feature",
				"stdbuf -o0 git pull",
				"stdbuf -o 0 git pull",
				"env -C /tmp git pull",
				// BSD env (macOS) alternate-path option.
				"env -P /usr/bin git pull",
				"time -o /tmp/t.log git pull",
			]) {
				expect(artifactsFromToolCall("bash", { command }, textResult(`done: ${abs}`), cwd), command).toEqual([])
			}
			// A non-git command in a chain still sniffs (no windowStart = no mtime gate).
			const out = artifactsFromToolCall("bash", { command: "make && echo done" }, textResult(`built ${abs}`), cwd)
			expect(out.map((a) => a.path)).toEqual([abs])

			// Positive control: commit message words must not parse as a subcommand.
			const commitOut = artifactsFromToolCall(
				"bash",
				{ command: 'git commit -m "restore thing" && echo done' },
				textResult(`wrote ${abs}`),
				cwd,
			)
			expect(commitOut.map((a) => a.path)).toEqual([abs])
		})

		it("falls back to sniffing when a wrapper has an unknown option argument", () => {
			// Unparsable `sudo --as root …`-style wrappers misclassify the git
			// call, so exclusion must not fire; the command degrades to plain
			// sniffing (which can still chip a genuinely produced file).
			const abs = touch("build.pdf")
			const out = artifactsFromToolCall(
				"bash",
				{ command: "sudo --unknownflag value git pull" },
				textResult(`wrote ${abs}`),
				cwd,
			)
			expect(out.map((a) => a.path)).toEqual([abs])
		})

		it("rejects directories that match the extension allowlist", () => {
			mkdirSync(join(cwd, "docs.md"), { recursive: true })
			expect(artifactsFromToolCall("bash", {}, textResult("docs.md"), cwd)).toEqual([])
		})

		it("resolves sniffed relative tokens against a leading cd", () => {
			const abs = touch("out/deck.pptx")
			const out = artifactsFromToolCall(
				"bash",
				{ command: "cd out && python make.py" },
				textResult("wrote deck.pptx"),
				cwd,
			)
			expect(out.map((a) => a.path)).toEqual([abs])
		})

		it("handles env-prefixed and powershell navigation", () => {
			const abs = touch("build/report.pdf")
			const envPrefixed = artifactsFromToolCall(
				"bash",
				{ command: "LANG=C cd build && pandoc -o report.pdf in.md" },
				textResult("report.pdf"),
				cwd,
			)
			expect(envPrefixed.map((a) => a.path)).toEqual([abs])
			const ps = artifactsFromToolCall(
				"powershell",
				{ command: "Set-Location build; Export report.pdf" },
				textResult("report.pdf"),
				cwd,
			)
			expect(ps.map((a) => a.path)).toEqual([abs])
		})

		it("ignores navigation that is not the leading segment", () => {
			const abs = touch("top.pdf")
			touch("sub/top.pdf")
			// mid-script cd: conservative miss — resolves against session cwd.
			const out = artifactsFromToolCall("bash", { command: "echo x; cd sub; make" }, textResult("wrote top.pdf"), cwd)
			expect(out.map((a) => a.path)).toEqual([abs])
		})
	})

	describe("sentence-final periods in bash output", () => {
		it("detects a path at the end of a sentence", () => {
			const abs = touch("report.md")
			const out = artifactsFromToolCall("bash", {}, textResult("Wrote report.md."), cwd)
			expect(out.map((a) => a.path)).toEqual([abs])
		})

		it("treats the trailing period as punctuation, not part of the token", () => {
			const abs = touch("a/out.pdf")
			const out = artifactsFromToolCall("bash", {}, textResult("done: a/out.pdf. Next step"), cwd)
			expect(out.map((a) => a.path)).toEqual([abs])
		})

		it("still rejects partial-extension matches (report.md.bak)", () => {
			expect(artifactsFromToolCall("bash", {}, textResult("report.md.bak"), cwd)).toEqual([])
		})
	})
})
