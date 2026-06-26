import { describe, expect, it } from "vitest"
import bashToolGuardExtension, {
	type BashCategory,
	type BashGuardBlockResult,
	type BashGuardWarnResult,
	BASH_TOOL_DESCRIPTION,
	BashToolGuard,
	TOOL_PREFERENCES_BLOCK,
	applyDescriptionOverride,
	classifyBashCommand,
	toolDescriptionOverride,
} from "./bash-tool-guard.js"

describe("classifyBashCommand — read patterns", () => {
	it("flags `cat <file>`", () => {
		expect(classifyBashCommand("cat src/foo.ts")).toMatchObject({
			category: "read",
			matchedSegment: "cat src/foo.ts",
			tool: "cat",
		})
	})

	it("flags `cat <file1> <file2>` (multiple files)", () => {
		expect(classifyBashCommand("cat a.ts b.ts")?.category).toBe("read")
	})

	it("flags `head -n 5 <file>`", () => {
		expect(classifyBashCommand("head -n 5 src/foo.ts")?.category).toBe("read")
	})

	it("flags `tail <file>`", () => {
		expect(classifyBashCommand("tail src/foo.ts")?.category).toBe("read")
	})

	it("flags `bat README.md`", () => {
		expect(classifyBashCommand("bat README.md")?.category).toBe("read")
	})

	it("flags `less <file>`", () => {
		expect(classifyBashCommand("less src/foo.ts")?.category).toBe("read")
	})

	it("flags `sed -n '1,5p' <file>` (read-only sed)", () => {
		expect(classifyBashCommand("sed -n '1,5p' src/foo.ts")?.category).toBe("read")
	})

	it("flags `sed -n /pattern/p file`", () => {
		expect(classifyBashCommand("sed -n /pattern/p src/foo.ts")?.category).toBe("read")
	})

	it("flags `rtk cat foo.ts` (strips RTK wrapper)", () => {
		expect(classifyBashCommand("rtk cat foo.ts")?.category).toBe("read")
	})

	it("does not flag `cat` (no args, stdin)", () => {
		expect(classifyBashCommand("cat")).toBeNull()
	})

	it("does not flag `head` (no args)", () => {
		expect(classifyBashCommand("head")).toBeNull()
	})

	it("does not flag bare `sed` (no -n, no read intent)", () => {
		expect(classifyBashCommand("sed 's/foo/bar/' src/foo.ts")).toBeNull()
	})

	it("suggestion for read mentions the read tool", () => {
		expect(classifyBashCommand("cat src/foo.ts")?.suggestion).toMatch(/read tool/)
	})

	it("exposes the tool name (for telemetry)", () => {
		expect(classifyBashCommand("sed -n '1,5p' foo.ts")?.tool).toBe("sed")
		expect(classifyBashCommand("rtk cat foo.ts")?.tool).toBe("cat")
	})
})

describe("classifyBashCommand — edit patterns", () => {
	it("flags `sed -i 's/foo/bar/g' file`", () => {
		expect(classifyBashCommand("sed -i 's/foo/bar/g' src/foo.ts")?.category).toBe("edit")
	})

	it("flags `sed -i.bak '...' file` (suffix arg)", () => {
		expect(classifyBashCommand("sed -i.bak 's/foo/bar/g' src/foo.ts")?.category).toBe("edit")
	})

	it("flags `perl -i -pe 's/foo/bar/' file`", () => {
		expect(classifyBashCommand("perl -i -pe 's/foo/bar/' src/foo.ts")?.category).toBe("edit")
	})

	it("flags `perl -i.bak -pe 's/foo/bar/' file`", () => {
		expect(classifyBashCommand("perl -i.bak -pe 's/foo/bar/' src/foo.ts")?.category).toBe("edit")
	})

	it("flags `awk -i inplace '{print $1}' file`", () => {
		expect(classifyBashCommand("awk -i inplace '{print $1}' src/foo.ts")?.category).toBe("edit")
	})

	it("edit wins over read when both flags present (sed -n -i)", () => {
		// Order matters: edit category is checked first, so -i dominates.
		expect(classifyBashCommand("sed -n -i 's/foo/bar/' src/foo.ts")?.category).toBe("edit")
	})

	it("suggestion for edit mentions the edit tool", () => {
		expect(classifyBashCommand("sed -i 's/foo/bar/' src/foo.ts")?.suggestion).toMatch(/edit tool/)
	})
})

describe("classifyBashCommand — write patterns", () => {
	it("flags `echo '...' > file`", () => {
		expect(classifyBashCommand("echo 'hello' > src/foo.ts")?.category).toBe("write")
	})

	it("flags `printf ... >> file`", () => {
		expect(classifyBashCommand('printf "%s\\n" "hi" >> src/foo.ts')?.category).toBe("write")
	})

	it("flags `tee file` (writes stdin to file)", () => {
		expect(classifyBashCommand("tee src/foo.ts")?.category).toBe("write")
	})

	it("flags heredoc redirect: `cat <<EOF > file`", () => {
		expect(classifyBashCommand("cat <<EOF > src/foo.ts\nhi\nEOF")?.category).toBe("write")
	})

	it("does not flag `echo '...' > /dev/null` (stream target)", () => {
		expect(classifyBashCommand("echo 'progress' > /dev/null")).toBeNull()
	})

	it("does not flag `echo 'build done'` (no redirect)", () => {
		expect(classifyBashCommand("echo 'build done'")).toBeNull()
	})

	it("does not flag `echo 'log' > /dev/stderr`", () => {
		expect(classifyBashCommand("echo 'log' > /dev/stderr")).toBeNull()
	})

	it("write wins over read when both present (`echo x > cat-target`)", () => {
		// Order matters: write (redirects) is checked before read.
		expect(classifyBashCommand("echo 'hi' > src/foo.ts")?.category).toBe("write")
	})

	it("suggestion for write mentions edit/write tools", () => {
		const suggestion = classifyBashCommand("echo 'hi' > src/foo.ts")?.suggestion ?? ""
		expect(suggestion).toMatch(/edit tool/)
		expect(suggestion).toMatch(/write tool/)
	})
})

describe("classifyBashCommand — negative (allowed bash)", () => {
	it.each([
		["git status", null],
		["git log --oneline -20", null],
		["git diff HEAD~1", null],
		["pnpm test", null],
		["pnpm run build", null],
		["node script.js", null],
		["ls -la src/", null],
		["ls src/", null],
		["grep -r 'TODO' src/", null], // grep intentionally not guarded
		["rg 'foo' src/", null],
		["find . -name '*.ts' -type f", null],
		["du -sh node_modules", null],
		["df -h", null],
		["ps aux", null],
		["cd src && pnpm test", null], // legit compound
		["git status && git log", null], // legit compound
		["mkdir -p dist", null],
		["mv old new", null], // mv not yet guarded (could be a future enhancement)
	])("does not flag %s", (cmd, expected) => {
		expect(classifyBashCommand(cmd)).toBe(expected)
	})
})

describe("classifyBashCommand — compound commands", () => {
	it("flags first segment when it's a read", () => {
		expect(classifyBashCommand("cat foo.ts && echo done")?.category).toBe("read")
	})

	it("flags when later segment is a write even if first is legit", () => {
		expect(classifyBashCommand("git status; echo 'x' > foo.ts")?.category).toBe("write")
	})

	it("flags when any segment is a write", () => {
		expect(classifyBashCommand("git pull && echo 'done' > progress.txt")?.category).toBe("write")
	})

	it("flags the first offending segment in order (edit wins over later write)", () => {
		// Implementation checks write → edit → read in order; the edit
		// segment comes first, so it's flagged as edit.
		expect(classifyBashCommand("sed -i 's/a/b/' foo.ts; echo 'done' > progress.txt")?.category).toBe("edit")
	})

	it("flags pipe where first segment is a read", () => {
		expect(classifyBashCommand("cat foo.ts | head -n 5")?.category).toBe("read")
	})
})

describe("BashToolGuard", () => {
	it("returns allow for non-matching commands", () => {
		const guard = new BashToolGuard()
		expect(guard.recordCommand("git status")).toEqual({ decision: "allow" })
		expect(guard.recordCommand("pnpm test")).toEqual({ decision: "allow" })
	})

	it("returns warn on first match per category", () => {
		const guard = new BashToolGuard()
		const result = guard.recordCommand("cat foo.ts") as BashGuardWarnResult
		expect(result.decision).toBe("warn")
		expect(result.category).toBe("read")
		expect(result.suggestion).toMatch(/read tool/)
		expect(result.count).toBe(1)
	})

	it("returns block on second match of same category (when blockOnThreshold=true)", () => {
		const guard = new BashToolGuard({ blockOnThreshold: true })
		guard.recordCommand("cat foo.ts")
		const result = guard.recordCommand("head -n 5 bar.ts") as BashGuardBlockResult
		expect(result.decision).toBe("block")
		expect(result.category).toBe("read")
		expect(result.count).toBe(2)
	})

	it("keeps steering after threshold when blockOnThreshold is false (default)", () => {
		// Default behaviour: warn-only. The guard never refuses a bash call
		// unless the caller explicitly opts in via blockOnThreshold: true.
		const guard = new BashToolGuard()
		expect(guard.recordCommand("cat foo.ts").decision).toBe("warn")
		expect(guard.recordCommand("cat bar.ts").decision).toBe("warn")
		expect(guard.recordCommand("cat baz.ts").decision).toBe("warn")
		expect(guard.recordCommand("cat qux.ts").decision).toBe("warn")
	})

	it("uses per-category counters (cat doesn't burn sed budget)", () => {
		const guard = new BashToolGuard({ blockOnThreshold: true })
		expect(guard.recordCommand("cat foo.ts").decision).toBe("warn")
		// Different category, fresh budget → warn again, not block.
		expect(guard.recordCommand("sed -i 's/foo/bar/' foo.ts").decision).toBe("warn")
		expect(guard.recordCommand("echo 'x' > bar.ts").decision).toBe("warn")
		// Now each category has had its warn, second occurrence blocks.
		expect(guard.recordCommand("cat baz.ts").decision).toBe("block")
		expect(guard.recordCommand("sed -i 's/a/b/' baz.ts").decision).toBe("block")
		expect(guard.recordCommand("echo 'y' > qux.ts").decision).toBe("block")
	})

	it("respects custom warnThreshold (global)", () => {
		const guard = new BashToolGuard({ warnThreshold: 2, blockOnThreshold: true })
		expect(guard.recordCommand("cat a.ts").decision).toBe("warn")
		expect(guard.recordCommand("cat b.ts").decision).toBe("warn")
		expect(guard.recordCommand("cat c.ts").decision).toBe("block")
	})

	it("respects per-category warnThresholds", () => {
		const guard = new BashToolGuard({
			warnThresholds: { read: 3, edit: 0, write: 1 },
			blockOnThreshold: true,
		})
		// read budget = 3 warns before block
		expect(guard.recordCommand("cat a.ts").decision).toBe("warn")
		expect(guard.recordCommand("cat b.ts").decision).toBe("warn")
		expect(guard.recordCommand("cat c.ts").decision).toBe("warn")
		expect(guard.recordCommand("cat d.ts").decision).toBe("block")
		// edit budget = 0 warns → first occurrence blocks
		expect(guard.recordCommand("sed -i 's/a/b/' e.ts").decision).toBe("block")
		// write budget = 1 warn (default) → first warns, second blocks
		expect(guard.recordCommand("echo 'x' > f.ts").decision).toBe("warn")
		expect(guard.recordCommand("echo 'y' > g.ts").decision).toBe("block")
	})

	it("per-category overrides fallback to global warnThreshold when partial", () => {
		const guard = new BashToolGuard({
			warnThreshold: 1,
			warnThresholds: { edit: 3 },
			blockOnThreshold: true,
		})
		// read falls back to global (1)
		expect(guard.recordCommand("cat a.ts").decision).toBe("warn")
		expect(guard.recordCommand("cat b.ts").decision).toBe("block")
		// write falls back to global (1)
		expect(guard.recordCommand("echo 'x' > a.ts").decision).toBe("warn")
		// edit uses override (3)
		expect(guard.recordCommand("sed -i 's/a/b/' a.ts").decision).toBe("warn")
		expect(guard.recordCommand("sed -i 's/c/d/' a.ts").decision).toBe("warn")
		expect(guard.recordCommand("sed -i 's/e/f/' a.ts").decision).toBe("warn")
		expect(guard.recordCommand("sed -i 's/g/h/' a.ts").decision).toBe("block")
	})

	it("reset() clears all counters", () => {
		const guard = new BashToolGuard()
		guard.recordCommand("cat a.ts")
		guard.recordCommand("cat b.ts") // would have been block
		guard.reset()
		expect(guard.getCount("read")).toBe(0)
		expect(guard.recordCommand("cat c.ts").decision).toBe("warn")
	})

	it("isEnabled=false short-circuits to allow", () => {
		const guard = new BashToolGuard({ isEnabled: () => false })
		expect(guard.recordCommand("cat foo.ts")).toEqual({ decision: "allow" })
		expect(guard.recordCommand("cat foo.ts")).toEqual({ decision: "allow" })
		expect(guard.recordCommand("sed -i 's/foo/bar/' foo.ts")).toEqual({ decision: "allow" })
	})

	it("formatWarnText fills placeholders", () => {
		const guard = new BashToolGuard()
		const result = guard.recordCommand("cat foo.ts") as BashGuardWarnResult
		const text = guard.formatWarnText(result)
		expect(text).toContain("cat foo.ts")
		expect(text).toContain("read")
		expect(text).toMatch(/read tool/)
	})

	it("formatBlockReason fills placeholders", () => {
		const guard = new BashToolGuard()
		guard.recordCommand("cat a.ts")
		const result = guard.recordCommand("cat b.ts") as BashGuardBlockResult
		const text = guard.formatBlockReason(result)
		expect(text).toContain("read")
		expect(text).toMatch(/read tool/)
		expect(text).toMatch(/blocked/i)
	})

	it("getCount returns 0 for unseen category", () => {
		const guard = new BashToolGuard()
		expect(guard.getCount("read")).toBe(0)
		expect(guard.getCount("edit")).toBe(0)
		expect(guard.getCount("write")).toBe(0)
	})

	it("getCount returns accumulated count after matches", () => {
		const guard = new BashToolGuard()
		guard.recordCommand("cat a.ts")
		guard.recordCommand("cat b.ts")
		expect(guard.getCount("read")).toBe(2)
		expect(guard.getCount("edit")).toBe(0)
	})

	it("getWarnThreshold returns per-category threshold", () => {
		const guard = new BashToolGuard({ warnThresholds: { read: 2, edit: 0, write: 3 } })
		expect(guard.getWarnThreshold("read")).toBe(2)
		expect(guard.getWarnThreshold("edit")).toBe(0)
		expect(guard.getWarnThreshold("write")).toBe(3)
	})

	it.each<BashCategory>(["read", "edit", "write"])("tracks %s category independently", (category) => {
		const guard = new BashToolGuard()
		const triggerByCategory: Record<BashCategory, string> = {
			read: "cat foo.ts",
			edit: "sed -i 's/a/b/' foo.ts",
			write: "echo 'x' > foo.ts",
		}
		const result = guard.recordCommand(triggerByCategory[category]) as BashGuardWarnResult
		expect(result.category).toBe(category)
		expect(guard.getCount(category)).toBe(1)
	})

	it("returns user-request allow reason when explicitly requested", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("please use sed to fix foo.ts")
		const result = guard.recordCommand("sed -i 's/typo/fix/' foo.ts")
		expect(result).toEqual({ decision: "allow", reason: "user-request" })
	})

	it("returns plain allow (no reason) when no user request and no match", () => {
		const guard = new BashToolGuard()
		expect(guard.recordCommand("git status")).toEqual({ decision: "allow" })
	})
})

describe("BashToolGuard — explicit user request override (tool name)", () => {
	it("allows when user prompt mentions the matched tool", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("please use sed to fix the typo in foo.ts")
		expect(guard.recordCommand("sed -i 's/typo/fix/' foo.ts")).toEqual({
			decision: "allow",
			reason: "user-request",
		})
	})

	it("allows 'cat this file'", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("cat src/foo.ts and tell me what it does")
		expect(guard.recordCommand("cat src/foo.ts")).toEqual({ decision: "allow", reason: "user-request" })
	})

	it("allows 'use echo to write'", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("use echo to create a marker file")
		expect(guard.recordCommand("echo 'done' > marker.txt")).toEqual({
			decision: "allow",
			reason: "user-request",
		})
	})

	it("allows across repeated matches when explicitly requested", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("cat foo.ts")
		expect(guard.recordCommand("cat foo.ts")).toEqual({ decision: "allow", reason: "user-request" })
		expect(guard.recordCommand("cat foo.ts")).toEqual({ decision: "allow", reason: "user-request" })
		expect(guard.recordCommand("cat foo.ts")).toEqual({ decision: "allow", reason: "user-request" })
	})

	it("blocks when user prompt does NOT mention the tool AND has no semantic intent (opt-in)", () => {
		const guard = new BashToolGuard({ blockOnThreshold: true })
		// 'fix the typo in foo.ts' would match the edit semantic intent
		// pattern, so use a prompt that mentions neither tool nor intent.
		guard.setLastUserPrompt("please change foo.ts")
		expect(guard.recordCommand("sed -i 's/typo/fix/' foo.ts").decision).toBe("warn")
		expect(guard.recordCommand("sed -i 's/x/y/' foo.ts").decision).toBe("block")
	})

	it("warns repeatedly when user prompt lacks explicit intent (default opt-in)", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("please change foo.ts")
		expect(guard.recordCommand("sed -i 's/typo/fix/' foo.ts").decision).toBe("warn")
		expect(guard.recordCommand("sed -i 's/x/y/' foo.ts").decision).toBe("warn")
		expect(guard.recordCommand("sed -i 's/a/b/' foo.ts").decision).toBe("warn")
	})

	it("uses word-boundary matching (no false positives on substrings)", () => {
		const guard = new BashToolGuard()
		// 'cat' inside 'categorize' should NOT trigger the override.
		guard.setLastUserPrompt("categorize the files")
		expect(guard.recordCommand("cat foo.ts").decision).toBe("warn")
	})

	it("uses word-boundary matching (no false positives on similar words)", () => {
		const guard = new BashToolGuard()
		// 'sed' inside 'used' should NOT trigger the override.
		guard.setLastUserPrompt("the tool used for editing")
		expect(guard.recordCommand("sed -i 's/a/b/' foo.ts").decision).toBe("warn")
	})

	it("reset() clears the last prompt", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("cat foo.ts")
		expect(guard.recordCommand("cat foo.ts")).toEqual({ decision: "allow", reason: "user-request" })
		guard.reset()
		expect(guard.recordCommand("cat foo.ts").decision).toBe("warn")
	})

	it("explicit request overrides per-category but other categories still guard", () => {
		const guard = new BashToolGuard({ blockOnThreshold: true })
		guard.setLastUserPrompt("use sed to fix foo.ts")
		// sed is explicitly requested → allow
		expect(guard.recordCommand("sed -i 's/a/b/' foo.ts")).toEqual({
			decision: "allow",
			reason: "user-request",
		})
		// cat is not mentioned → still guarded
		expect(guard.recordCommand("cat foo.ts").decision).toBe("warn")
		expect(guard.recordCommand("cat foo.ts").decision).toBe("block")
	})

	it("isExplicitlyRequested returns false when no prompt set", () => {
		const guard = new BashToolGuard()
		expect(guard.isExplicitlyRequested("cat foo.ts", "read")).toBe(false)
	})

	it("isExplicitlyRequested returns false for empty matchedSegment", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("cat the file")
		expect(guard.isExplicitlyRequested("", "read")).toBe(false)
	})

	it("case-insensitive matching", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("Use CAT to read the file")
		expect(guard.recordCommand("cat foo.ts")).toEqual({ decision: "allow", reason: "user-request" })
	})

	it("matches tools wrapped in RTK (matchedSegment is the unwrapped form)", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("use cat to read foo.ts")
		// matchedSegment is "cat foo.ts" after stripRtk
		expect(guard.recordCommand("rtk cat foo.ts")).toEqual({ decision: "allow", reason: "user-request" })
	})

	it("isExplicitlyRequested takes category argument (semantic intent uses it)", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("please read the file foo.ts")
		// Program 'cat' is not mentioned, but the 'read the file' semantic
		// pattern matches → still allowed.
		expect(guard.isExplicitlyRequested("cat foo.ts", "read")).toBe(true)
		// Same prompt but 'edit' category: semantic patterns differ.
		expect(guard.isExplicitlyRequested("sed -i 's/a/b/' foo.ts", "edit")).toBe(false)
	})

	it("getLastUserPrompt returns the lowercased prompt", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("Read The FILE foo.ts")
		expect(guard.getLastUserPrompt()).toBe("read the file foo.ts")
	})
})

describe("BashToolGuard — semantic intent override (no tool name)", () => {
	// These tests verify the guard detects intent phrases like "read the file"
	// even when the user doesn't name the tool explicitly.

	describe("read intent", () => {
		it("'read the file foo.ts' allows cat", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("read the file foo.ts")
			expect(guard.recordCommand("cat foo.ts")).toEqual({ decision: "allow", reason: "user-request" })
		})

		it("'show me foo.ts' allows cat", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("show me what's in foo.ts")
			expect(guard.recordCommand("cat foo.ts")).toEqual({ decision: "allow", reason: "user-request" })
		})

		it("'print the contents of foo.ts' allows cat", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("print the contents of foo.ts")
			expect(guard.recordCommand("cat foo.ts")).toEqual({ decision: "allow", reason: "user-request" })
		})

		it("'view the source' allows less", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("view the source for me")
			expect(guard.recordCommand("less foo.ts")).toEqual({ decision: "allow", reason: "user-request" })
		})

		it("'open foo.ts' allows cat (intent to inspect)", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("open foo.ts")
			expect(guard.recordCommand("cat foo.ts")).toEqual({ decision: "allow", reason: "user-request" })
		})

		it("does NOT trigger edit semantic patterns for read", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("read the file foo.ts")
			// Same prompt — edit semantic patterns must NOT match
			expect(guard.isExplicitlyRequested("sed -i 's/a/b/' foo.ts", "edit")).toBe(false)
		})
	})

	describe("edit intent", () => {
		it("'fix the typo in foo.ts' allows sed", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("fix the typo in foo.ts")
			expect(guard.recordCommand("sed -i 's/typo/fix/' foo.ts")).toEqual({
				decision: "allow",
				reason: "user-request",
			})
		})

		it("'replace foo with bar in file.ts' allows sed", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("replace foo with bar in file.ts")
			expect(guard.recordCommand("sed -i 's/foo/bar/' file.ts")).toEqual({
				decision: "allow",
				reason: "user-request",
			})
		})

		it("'modify foo.ts' allows perl", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("modify foo.ts to add the export")
			expect(guard.recordCommand("perl -i -pe 's/a/b/' foo.ts")).toEqual({
				decision: "allow",
				reason: "user-request",
			})
		})

		it("'update the file with the new value' allows sed", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("update the file with the new value")
			expect(guard.recordCommand("sed -i 's/old/new/' file.ts")).toEqual({
				decision: "allow",
				reason: "user-request",
			})
		})

		it("'use sed to fix this' allows sed", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("use sed to fix this")
			expect(guard.recordCommand("sed -i 's/a/b/' file.ts")).toEqual({
				decision: "allow",
				reason: "user-request",
			})
		})

		it("'edit foo.ts' allows sed", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("edit foo.ts")
			expect(guard.recordCommand("sed -i 's/a/b/' foo.ts")).toEqual({
				decision: "allow",
				reason: "user-request",
			})
		})

		it("does NOT trigger write semantic patterns for edit", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("fix the typo in foo.ts")
			expect(guard.isExplicitlyRequested("echo 'x' > foo.ts", "write")).toBe(false)
		})
	})

	describe("write intent", () => {
		it("'write to foo.ts' allows echo redirect", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("write the result to foo.ts")
			expect(guard.recordCommand("echo 'done' > foo.ts")).toEqual({
				decision: "allow",
				reason: "user-request",
			})
		})

		it("'create a foo.ts file' allows echo redirect", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("create a foo.ts file")
			expect(guard.recordCommand("echo 'content' > foo.ts")).toEqual({
				decision: "allow",
				reason: "user-request",
			})
		})

		it("'save the output to log.txt' allows tee", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("save the output to log.txt")
			expect(guard.recordCommand("tee log.txt")).toEqual({ decision: "allow", reason: "user-request" })
		})

		it("'put the result in output.txt' allows echo redirect", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("put the result in output.txt")
			expect(guard.recordCommand("echo 'done' > output.txt")).toEqual({
				decision: "allow",
				reason: "user-request",
			})
		})

		it("'echo ... to file' allows echo redirect", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("echo the line to the file")
			expect(guard.recordCommand("echo 'done' > foo.ts")).toEqual({
				decision: "allow",
				reason: "user-request",
			})
		})

		it("'redirect to file.txt' allows echo redirect", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("redirect the output to file.txt")
			expect(guard.recordCommand("echo 'done' > file.txt")).toEqual({
				decision: "allow",
				reason: "user-request",
			})
		})

		it("does NOT trigger read semantic patterns for write", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("write to foo.ts")
			expect(guard.isExplicitlyRequested("cat foo.ts", "read")).toBe(false)
		})
	})

	describe("semantic intent negative cases", () => {
		it("'look at the build output' does not allow cat", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("look at the build output")
			expect(guard.recordCommand("cat foo.ts").decision).toBe("warn")
		})

		it("'just readme' does not allow cat (no file context)", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("just readme")
			expect(guard.recordCommand("cat foo.ts").decision).toBe("warn")
		})

		it("'please be careful' does not allow sed", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("please be careful")
			expect(guard.recordCommand("sed -i 's/a/b/' foo.ts").decision).toBe("warn")
		})

		it("'no changes needed' does not allow echo", () => {
			const guard = new BashToolGuard()
			guard.setLastUserPrompt("no changes needed")
			expect(guard.recordCommand("echo 'x' > foo.ts").decision).toBe("warn")
		})
	})
})

// =============================================================================
// Preference (upstream nudging)
// =============================================================================
//
// The guard steers AFTER the model picks bash for a file op. The
// preference block + description override steers BEFORE — nudging the model
// to pick the dedicated tool in the first place. These tests cover the
// pure helpers exported for that purpose and the default extension's
// integration with the system prompt block + session_start mutation.

describe("TOOL_PREFERENCES_BLOCK", () => {
	it("contains the section header", () => {
		expect(TOOL_PREFERENCES_BLOCK).toContain("## Tool Preferences")
	})

	it("maps each file operation to its dedicated tool", () => {
		// Each line should pair the file operation with the dedicated
		// tool name in backticks. Verifying the mapping catches
		// accidental edits that drop the substitution targets.
		expect(TOOL_PREFERENCES_BLOCK).toContain("use `read`")
		expect(TOOL_PREFERENCES_BLOCK).toContain("use `edit`")
		expect(TOOL_PREFERENCES_BLOCK).toContain("use `write`")
		expect(TOOL_PREFERENCES_BLOCK).toContain("use `grep`")
		expect(TOOL_PREFERENCES_BLOCK).toContain("use `find`")
		expect(TOOL_PREFERENCES_BLOCK).toContain("use `ls`")
	})

	it("lists the anti-patterns being discouraged", () => {
		// Spot-check the most common anti-patterns so we know the
		// guidance covers the cases bash-tool-guard steers on.
		expect(TOOL_PREFERENCES_BLOCK).toContain("cat")
		expect(TOOL_PREFERENCES_BLOCK).toContain("head")
		expect(TOOL_PREFERENCES_BLOCK).toContain("tail")
		expect(TOOL_PREFERENCES_BLOCK).toContain("sed -i")
	})

	it("specifies what bash IS for", () => {
		// The block must also say what bash is for, otherwise the model
		// would think bash is now useless for everything.
		expect(TOOL_PREFERENCES_BLOCK).toMatch(/build|test|git|package/i)
	})
})

describe("BASH_TOOL_DESCRIPTION", () => {
	it("describes what bash is for", () => {
		expect(BASH_TOOL_DESCRIPTION).toMatch(/build|test|git|package/i)
	})

	it("explicitly tells the model to use dedicated tools for file ops", () => {
		expect(BASH_TOOL_DESCRIPTION).toContain("use `read`")
		expect(BASH_TOOL_DESCRIPTION).toContain("use `edit`")
		expect(BASH_TOOL_DESCRIPTION).toContain("use `write`")
		expect(BASH_TOOL_DESCRIPTION).toContain("use `grep`")
		expect(BASH_TOOL_DESCRIPTION).toContain("use `find`")
		expect(BASH_TOOL_DESCRIPTION).toContain("use `ls`")
	})

	it("preserves the upstream truncation behaviour", () => {
		// The output truncation contract is important — dropping it would
		// change runtime semantics. Verify the truncation info survives.
		expect(BASH_TOOL_DESCRIPTION).toMatch(/truncat/i)
	})
})

describe("toolDescriptionOverride", () => {
	it("returns the override for the bash tool", () => {
		expect(toolDescriptionOverride("bash")).toBe(BASH_TOOL_DESCRIPTION)
	})

	it("returns undefined for non-bash tools", () => {
		expect(toolDescriptionOverride("read")).toBeUndefined()
		expect(toolDescriptionOverride("edit")).toBeUndefined()
		expect(toolDescriptionOverride("grep")).toBeUndefined()
		expect(toolDescriptionOverride("Agent")).toBeUndefined()
		expect(toolDescriptionOverride("")).toBeUndefined()
	})
})

describe("applyDescriptionOverride", () => {
	it("overrides the description for bash", () => {
		const tool = { name: "bash", description: "old description" }
		const result = applyDescriptionOverride(tool)
		expect(result.description).toBe(BASH_TOOL_DESCRIPTION)
	})

	it("does not mutate the input object", () => {
		const tool = { name: "read", description: "unchanged" }
		const result = applyDescriptionOverride(tool)
		expect(result).not.toBe(tool)
		expect(result.description).toBe("unchanged")
	})

	it("passes through non-bash tools with the same description", () => {
		const tool = { name: "read", description: "Read file contents" }
		const result = applyDescriptionOverride(tool)
		expect(result.description).toBe("Read file contents")
	})
})

describe("bashToolGuardExtension — preference integration", () => {
	interface MockTool {
		name: string
		description: string
	}

	interface MockPI {
		handlers: Record<string, Array<(event: unknown) => unknown>>
		on(event: string, handler: (event: unknown) => unknown): void
		setTools(tools: MockTool[]): void
		getAllTools(): MockTool[]
	}

	function createMockPI(): MockPI {
		const handlers: MockPI["handlers"] = {}
		let tools: MockTool[] = []
		return {
			handlers,
			setTools(t) {
				tools = t
			},
			getAllTools() {
				return tools
			},
			on(event, handler) {
				if (!handlers[event]) handlers[event] = []
				handlers[event].push(handler)
			},
		}
	}

	function fireSessionStart(pi: MockPI): void {
		const handlers = pi.handlers.session_start ?? []
		for (const handler of handlers) handler({})
	}

	it("mutates the bash tool description on session_start", () => {
		const pi = createMockPI()
		// The extension requires more API surface than the mock
		// provides — cast through `unknown` so the test stays focused
		// on the session_start hook behavior.
		bashToolGuardExtension(pi as unknown as Parameters<typeof bashToolGuardExtension>[0])

		const tools = [
			{ name: "read", description: "Read file contents" },
			{ name: "bash", description: "Execute bash commands (ls, grep, find, etc.)" },
			{ name: "edit", description: "Edit a file" },
		]
		pi.setTools(tools)

		fireSessionStart(pi)

		expect(tools[1].description).toBe(BASH_TOOL_DESCRIPTION)
	})

	it("does not mutate non-bash tools", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as Parameters<typeof bashToolGuardExtension>[0])

		const tools = [
			{ name: "read", description: "Read file contents" },
			{ name: "edit", description: "Edit a file" },
			{ name: "grep", description: "Search file contents" },
		]
		pi.setTools(tools)

		fireSessionStart(pi)

		// All non-bash tools should be byte-for-byte unchanged.
		expect(tools[0].description).toBe("Read file contents")
		expect(tools[1].description).toBe("Edit a file")
		expect(tools[2].description).toBe("Search file contents")
	})

	it("is safe when no bash tool is registered", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as Parameters<typeof bashToolGuardExtension>[0])

		pi.setTools([{ name: "read", description: "Read file contents" }])

		expect(() => fireSessionStart(pi)).not.toThrow()
	})

	it("is safe when the tool list is empty", () => {
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as Parameters<typeof bashToolGuardExtension>[0])
		pi.setTools([])
		expect(() => fireSessionStart(pi)).not.toThrow()
	})

	it("mutates the actual tool object so downstream reads see the change", () => {
		// The kimchi prompt-enrichment handler reads pi.getAllTools() and
		// passes the same object references to buildSystemPrompt. If the
		// extension returns a new object, the mutation never reaches the
		// prompt. Guard against accidental reassignment.
		const pi = createMockPI()
		bashToolGuardExtension(pi as unknown as Parameters<typeof bashToolGuardExtension>[0])
		const bashTool = { name: "bash", description: "old" }
		pi.setTools([bashTool])

		fireSessionStart(pi)

		expect(pi.getAllTools()[0]).toBe(bashTool)
		expect(bashTool.description).toBe(BASH_TOOL_DESCRIPTION)
	})
})
