/**
 * Pure-function unit tests for bash-tool-guard.ts: command classification,
 * the BashToolGuard class, and description-override helpers.
 *
 * Tests that exercise the wired `bashToolGuardExtension` against a mock
 * ExtensionAPI (session_start/tool_call handlers) live in
 * bash-tool-guard.integration.test.ts instead.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	applyDescriptionOverride,
	type BashCategory,
	type BashGuardBlockResult,
	type BashGuardWarnResult,
	BashToolGuard,
	bashToolDescription,
	classifyBashCommand,
	toolDescriptionOverride,
} from "./bash-tool-guard.js"
import { setExperimentalFeaturesEnabled } from "./experimental.js"

afterEach(() => {
	// Module-level singleton — restore default so suites don't leak state.
	setExperimentalFeaturesEnabled(false)
})

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
		expect(classifyBashCommand("head -n 5 README")?.category).toBe("read")
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
		expect(classifyBashCommand("rtk rtk cat foo.ts")?.category).toBe("read")
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
		["echo 'hello'", null], // echo with no redirect or backgrounding
		["echo 'done' && echo 'world'", null], // && is logical AND, not backgrounding
	])("does not flag %s", (cmd, expected) => {
		expect(classifyBashCommand(cmd)).toBe(expected)
	})
})

describe("classifyBashCommand — backgrounding patterns", () => {
	it("flags `nohup python3 ... & echo PID=$!`", () => {
		const result = classifyBashCommand(
			'cd /app && nohup python3 -u pystan_analysis.py > /app/run.log 2>&1 & echo "PID=$!"',
		)
		expect(result?.category).toBe("background")
		expect(result?.tool).toBe("nohup")
	})

	it("flags `nohup ... & disown; echo ...`", () => {
		const result = classifyBashCommand('nohup python3 run.py > run.log 2>&1 & disown; echo "launched PID $!"')
		expect(result?.category).toBe("background")
		expect(result?.tool).toBe("nohup")
	})

	it("flags bare `disown`", () => {
		const result = classifyBashCommand("python3 run.py & disown")
		expect(result?.category).toBe("background")
	})

	it("flags `python3 ... > /app/run.log 2>&1 &`", () => {
		const result = classifyBashCommand("cd /app && python3 -u run.py > /app/run.log 2>&1 &")
		expect(result?.category).toBe("background")
		expect(result?.tool).toBe("&")
	})

	it("flags subshell backgrounding `(... > /app/run.log 2>&1 &) echo ...`", () => {
		const result = classifyBashCommand(
			'(echo "START"; timeout 1200 python -u convert_masks.py; echo "EXIT=$?") > /app/run_full3.log 2>&1 &\necho "launched pid $!"',
		)
		expect(result?.category).toBe("background")
		expect(result?.tool).toBe("&")
	})

	it("flags `& echo PID` pattern", () => {
		const result = classifyBashCommand('python3 run.py & echo "PID=$!"')
		expect(result?.category).toBe("background")
	})

	it("flags `& sleep 60` pattern", () => {
		const result = classifyBashCommand("python3 run.py & sleep 60")
		expect(result?.category).toBe("background")
	})

	it("flags `& wait` pattern", () => {
		const result = classifyBashCommand("setsid bash -c 'echo hi' & wait")
		expect(result?.category).toBe("background")
	})

	it("suggestion mentions timeout and bash_control", () => {
		const result = classifyBashCommand("nohup python3 run.py &")
		expect(result?.suggestion).toMatch(/timeout/)
		expect(result?.suggestion).toMatch(/bash_control/)
	})

	it("does not flag `&&` (logical AND)", () => {
		expect(classifyBashCommand("git status && git log")).toBeNull()
		expect(classifyBashCommand("cd src && pnpm test")).toBeNull()
		expect(classifyBashCommand("echo 'hello' && echo 'world'")).toBeNull()
	})

	it("does not treat file-descriptor redirection as backgrounding", () => {
		expect(classifyBashCommand("gh pr view 1 2>&1")).toBeNull()
		expect(classifyBashCommand("cmd >&2")).toBeNull()
		expect(classifyBashCommand("gh pr view 1 2>&1 | head -n 5")).toBeNull()
	})

	it("does not treat combined stdout/stderr redirection as backgrounding", () => {
		expect(classifyBashCommand("cmd &>run.log")?.category).toBe("write")
		expect(classifyBashCommand("cmd &>>run.log")?.category).toBe("write")
	})

	it("distinguishes spaced background operators from combined redirects", () => {
		expect(classifyBashCommand("sleep 10 & >run.log")?.category).toBe("background")
		expect(classifyBashCommand("sleep 10 & >/dev/null")?.category).toBe("background")
		expect(classifyBashCommand("sleep 10 & 2>/dev/null")?.category).toBe("background")
	})

	it("does not flag quoted or escaped ampersands", () => {
		expect(classifyBashCommand('echo "A & B"')).toBeNull()
		expect(classifyBashCommand("echo A \\& B")).toBeNull()
	})

	it("does not flag `> /dev/null` redirect without backgrounding", () => {
		expect(classifyBashCommand("echo 'progress' > /dev/null")).toBeNull()
	})

	it("does not flag nohup inside quoted strings", () => {
		expect(classifyBashCommand('echo "do not use nohup for this"')).toBeNull()
	})

	it("does not flag disown inside quoted strings", () => {
		expect(classifyBashCommand('echo "the word disown appears here"')).toBeNull()
	})

	it("flags bare `&` at end of command", () => {
		expect(classifyBashCommand("python3 run.py &")?.category).toBe("background")
	})

	it("flags `&` before comment", () => {
		expect(classifyBashCommand("python3 run.py & # background")?.category).toBe("background")
	})

	it("flags `&` before subshell", () => {
		expect(classifyBashCommand("python3 run.py & (other)")?.category).toBe("background")
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

	it.each<BashCategory>(["read", "edit", "write", "background"])("tracks %s category independently", (category) => {
		const guard = new BashToolGuard()
		const triggerByCategory: Record<BashCategory, string> = {
			read: "cat foo.ts",
			edit: "sed -i 's/a/b/' foo.ts",
			write: "echo 'x' > foo.ts",
			background: "nohup python3 run.py &",
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
// description override steers BEFORE — nudging the model to pick the
// dedicated tool in the first place. These tests cover the pure helpers
// exported for that purpose and the default extension's integration with
// the system prompt block + session_start mutation.

describe("BASH_TOOL_DESCRIPTION", () => {
	// Content assertions run against the FULL description (with the daemon
	// steer) — the public bashToolDescription() accessor with the flag on.
	beforeEach(() => {
		setExperimentalFeaturesEnabled(true)
	})
	it("describes what bash is for", () => {
		expect(bashToolDescription()).toMatch(/build|test|git|package/i)
	})

	it("explicitly tells the model to use dedicated tools for file ops", () => {
		expect(bashToolDescription()).toContain("use `read`")
		expect(bashToolDescription()).toContain("use `edit`")
		expect(bashToolDescription()).toContain("use `write`")
		expect(bashToolDescription()).toContain("use `grep`")
		expect(bashToolDescription()).toContain("use `find`")
		expect(bashToolDescription()).toContain("use `ls`")
	})

	it("preserves the upstream truncation behaviour", () => {
		// The output truncation contract is important — dropping it would
		// change runtime semantics. Verify the truncation info survives.
		expect(bashToolDescription()).toMatch(/truncat/i)
	})

	it("documents that cd does not persist between bash tool calls", () => {
		expect(bashToolDescription()).toContain("does NOT persist")
		expect(bashToolDescription()).toContain("cd <dir> && <command>")
	})

	it("warns against piping output through tail/head to hide it", () => {
		expect(bashToolDescription()).toMatch(/pipe.*tail.*head.*hide/i)
	})

	it("warns against backgrounding with nohup/disown/&", () => {
		expect(bashToolDescription()).toContain("nohup")
		expect(bashToolDescription()).toContain("disown")
		expect(bashToolDescription()).toContain("background")
	})

	it("suggests using long timeout and checkin_interval for long-running commands", () => {
		expect(bashToolDescription()).toMatch(/timeout=1800/)
		expect(bashToolDescription()).toMatch(/checkin_interval/)
	})
})

describe("toolDescriptionOverride", () => {
	it("returns the override for the bash tool when experimental features are enabled", () => {
		setExperimentalFeaturesEnabled(true)
		expect(toolDescriptionOverride("bash")).toBe(bashToolDescription())
	})

	it("strips the daemon sentence when experimental features are disabled", () => {
		setExperimentalFeaturesEnabled(false)
		const override = toolDescriptionOverride("bash")
		if (!override) throw new Error("expected bash description override")
		expect(override).not.toContain("`daemon`")
		expect(override).toContain(
			"Managed background (timeout/checkin_interval + bash_control) is killed when the session ends.",
		)
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
		setExperimentalFeaturesEnabled(true)
		const tool = { name: "bash", description: "old description" }
		const result = applyDescriptionOverride(tool)
		expect(result.description).toBe(bashToolDescription())
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
