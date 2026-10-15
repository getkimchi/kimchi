/**
 * Pure-function unit tests for bash-tool-guard.ts: command classification,
 * the BashToolGuard class, and description-override helpers.
 *
 * Tests that exercise the wired `bashToolGuardExtension` against a mock
 * ExtensionAPI (session_start/tool_call handlers) live in
 * bash-tool-guard.integration.test.ts instead — except the stat-gated
 * settings-reads suite at the bottom, which wires the extension via the
 * shared createExtensionApi mock to count real fs reads.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetJsonCacheForTest } from "../config/json.js"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import bashToolGuardExtension, {
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

// Counts real (open+read) reads of any settings.json, so the stat-gated
// cache test can prove that consecutive tool_call events stop re-reading
// the config file. Everything else delegates to the real fs.
const settingsReads = vi.hoisted(() => ({ count: 0 }))

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	const realReadFileSync = actual.readFileSync
	return {
		...actual,
		readFileSync: ((path: unknown, ...rest: unknown[]) => {
			if (typeof path === "string" && path.endsWith("settings.json")) settingsReads.count++
			return (realReadFileSync as (p: unknown, ...r: unknown[]) => unknown)(path, ...rest)
		}) as typeof actual.readFileSync,
	}
})

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
		expect(classifyBashCommand("cat foo.ts")?.tool).toBe("cat")
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

	it("suggestion mentions bash_control", () => {
		const result = classifyBashCommand("nohup python3 run.py &")
		expect(result?.suggestion).toMatch(/bash_control/)
		expect(result?.suggestion).toMatch(/stop_handles/)
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

	it("returns allow for read/edit/write matches (classification-only)", () => {
		const guard = new BashToolGuard()
		expect(guard.recordCommand("cat file.ts")).toEqual({ decision: "allow" })
		expect(guard.recordCommand("sed -i 's/a/b/' f")).toEqual({ decision: "allow" })
		expect(guard.recordCommand("echo hi > f")).toEqual({ decision: "allow" })
		expect(guard.recordCommand('printf "%s\\n" x >> f')).toEqual({ decision: "allow" })
		expect(guard.recordCommand("tee out.log")).toEqual({ decision: "allow" })
		expect(guard.recordCommand("head -n 30 train.txt > part1")).toEqual({ decision: "allow" })
		expect(guard.recordCommand("python3 - <<EOF > out")).toEqual({ decision: "allow" })
		// No counting for classification-only categories.
		expect(guard.getCount("read")).toBe(0)
		expect(guard.getCount("edit")).toBe(0)
		expect(guard.getCount("write")).toBe(0)
	})

	it("read/edit/write categories never steer regardless of user prompt", () => {
		const guard = new BashToolGuard()
		// No user prompt at all.
		expect(guard.recordCommand("cat foo.ts")).toEqual({ decision: "allow" })
		expect(guard.recordCommand("sed -i 's/a/b/' foo.ts")).toEqual({ decision: "allow" })
		expect(guard.recordCommand("echo 'x' > foo.ts")).toEqual({ decision: "allow" })
		// Matching user prompt — previously a user-request allow, now a plain
		// allow: explicit-request detection only runs for background.
		guard.setLastUserPrompt("cat foo.ts")
		expect(guard.recordCommand("cat foo.ts")).toEqual({ decision: "allow" })
		guard.setLastUserPrompt("use sed to fix foo.ts")
		expect(guard.recordCommand("sed -i 's/typo/fix/' foo.ts")).toEqual({ decision: "allow" })
		guard.setLastUserPrompt("write the result to output.txt")
		expect(guard.recordCommand("echo 'done' > output.txt")).toEqual({ decision: "allow" })
		expect(guard.getCount("read")).toBe(0)
		expect(guard.getCount("edit")).toBe(0)
		expect(guard.getCount("write")).toBe(0)
	})

	it("returns warn on first background match", () => {
		const guard = new BashToolGuard()
		const result = guard.recordCommand("nohup python3 run.py &") as BashGuardWarnResult
		expect(result.decision).toBe("warn")
		expect(result.category).toBe("background")
		expect(result.suggestion).toMatch(/bash_control/)
		expect(result.count).toBe(1)
	})

	it("returns block on second background match (when blockOnThreshold=true)", () => {
		const guard = new BashToolGuard({ blockOnThreshold: true })
		guard.recordCommand("nohup python3 run.py &")
		const result = guard.recordCommand("sleep 60 &") as BashGuardBlockResult
		expect(result.decision).toBe("block")
		expect(result.category).toBe("background")
		expect(result.count).toBe(2)
	})

	it("keeps steering after threshold when blockOnThreshold is false (default)", () => {
		// Default behaviour: warn-only. The guard never refuses a bash call
		// unless the caller explicitly opts in via blockOnThreshold: true.
		const guard = new BashToolGuard()
		expect(guard.recordCommand("sleep 1 &").decision).toBe("warn")
		expect(guard.recordCommand("sleep 2 &").decision).toBe("warn")
		expect(guard.recordCommand("sleep 3 &").decision).toBe("warn")
		expect(guard.recordCommand("sleep 4 &").decision).toBe("warn")
	})

	it("file-op matches don't burn the background budget", () => {
		const guard = new BashToolGuard({ blockOnThreshold: true })
		expect(guard.recordCommand("cat foo.ts").decision).toBe("allow")
		expect(guard.recordCommand("sed -i 's/a/b/' foo.ts").decision).toBe("allow")
		expect(guard.recordCommand("echo 'x' > bar.ts").decision).toBe("allow")
		// Background budget untouched by the file-op classifications.
		expect(guard.recordCommand("sleep 60 &").decision).toBe("warn")
		const result = guard.recordCommand("disown") as BashGuardBlockResult
		expect(result.decision).toBe("block")
		expect(result.count).toBe(2)
	})

	it("respects custom warnThreshold (global)", () => {
		const guard = new BashToolGuard({ warnThreshold: 2, blockOnThreshold: true })
		expect(guard.recordCommand("sleep 1 &").decision).toBe("warn")
		expect(guard.recordCommand("sleep 2 &").decision).toBe("warn")
		expect(guard.recordCommand("sleep 3 &").decision).toBe("block")
	})

	it("respects per-category warnThresholds (background)", () => {
		const guard = new BashToolGuard({
			warnThresholds: { read: 3, edit: 0, write: 1, background: 2 },
			blockOnThreshold: true,
		})
		// background budget = 2 warns before block
		expect(guard.recordCommand("sleep 1 &").decision).toBe("warn")
		expect(guard.recordCommand("sleep 2 &").decision).toBe("warn")
		expect(guard.recordCommand("sleep 3 &").decision).toBe("block")
		// read/edit/write thresholds are inert: classification-only
		// categories never steer or block regardless of their budgets.
		expect(guard.recordCommand("sed -i 's/a/b/' e.ts").decision).toBe("allow")
		expect(guard.recordCommand("echo 'x' > f.ts").decision).toBe("allow")
	})

	it("background falls back to global warnThreshold when not overridden", () => {
		const guard = new BashToolGuard({
			warnThreshold: 1,
			warnThresholds: { read: 3, edit: 0 },
			blockOnThreshold: true,
		})
		// background falls back to global (1)
		expect(guard.recordCommand("sleep 1 &").decision).toBe("warn")
		expect(guard.recordCommand("sleep 2 &").decision).toBe("block")
	})

	it("reset() clears all counters", () => {
		const guard = new BashToolGuard()
		guard.recordCommand("sleep 1 &")
		guard.recordCommand("sleep 2 &") // would have been block
		guard.reset()
		expect(guard.getCount("background")).toBe(0)
		expect(guard.recordCommand("sleep 3 &").decision).toBe("warn")
	})

	it("isEnabled=false short-circuits to allow", () => {
		const guard = new BashToolGuard({ isEnabled: () => false })
		expect(guard.recordCommand("nohup python3 run.py &")).toEqual({ decision: "allow" })
		expect(guard.recordCommand("sleep 60 &")).toEqual({ decision: "allow" })
		expect(guard.recordCommand("disown")).toEqual({ decision: "allow" })
	})

	it("formatWarnText fills placeholders", () => {
		const guard = new BashToolGuard()
		const result = guard.recordCommand("nohup python3 run.py &") as BashGuardWarnResult
		const text = guard.formatWarnText(result)
		expect(text).toContain("nohup python3 run.py")
		expect(text).toContain("detaches the process from the bash tool's lifecycle")
		expect(text).toMatch(/bash_control/)
		expect(text).not.toContain("%matchedSegment%")
		expect(text).not.toContain("%suggestion%")
	})

	it("formatBlockReason fills placeholders", () => {
		const guard = new BashToolGuard({ blockOnThreshold: true })
		guard.recordCommand("sleep 1 &")
		const result = guard.recordCommand("sleep 2 &") as BashGuardBlockResult
		const text = guard.formatBlockReason(result)
		expect(text).toContain("& (background)")
		expect(text).toContain("blocked backgrounding")
		expect(text).toMatch(/bash_control/)
		expect(text).not.toContain("%matchedSegment%")
		expect(text).not.toContain("%suggestion%")
	})

	it("background steer composes both mechanisms and never renders NaN (experimental on)", () => {
		setExperimentalFeaturesEnabled(true)
		const guard = new BashToolGuard({ blockOnThreshold: true })
		const warn = guard.recordCommand("sleep 60 &") as BashGuardWarnResult
		const warnText = guard.formatWarnText(warn)
		expect(warnText).toContain("bash_control stop_handles")
		expect(warnText).toContain("`daemon` tool")
		expect(warnText).not.toContain("NaN")
		guard.recordCommand("sleep 61 &")
		const block = guard.recordCommand("sleep 62 &") as BashGuardBlockResult
		const blockText = guard.formatBlockReason(block)
		expect(blockText).toContain("bash_control stop_handles")
		expect(blockText).toContain("`daemon` tool")
		expect(blockText).not.toContain("NaN")
	})

	it("background steer falls back to the restate-to-user guidance without daemon (experimental off)", () => {
		setExperimentalFeaturesEnabled(false)
		const guard = new BashToolGuard()
		const warn = guard.recordCommand("sleep 60 &") as BashGuardWarnResult
		const text = guard.formatWarnText(warn)
		expect(text).toContain("bash_control stop_handles")
		expect(text).toContain("restate that requirement to the user")
		expect(text).not.toContain("`daemon` tool")
		expect(text).not.toContain("NaN")
	})

	it("getCount returns 0 for unseen category", () => {
		const guard = new BashToolGuard()
		expect(guard.getCount("read")).toBe(0)
		expect(guard.getCount("edit")).toBe(0)
		expect(guard.getCount("write")).toBe(0)
		expect(guard.getCount("background")).toBe(0)
	})

	it("getCount returns accumulated count after background matches", () => {
		const guard = new BashToolGuard()
		guard.recordCommand("sleep 1 &")
		guard.recordCommand("nohup python3 run.py &")
		expect(guard.getCount("background")).toBe(2)
		// read/edit/write matches never count.
		guard.recordCommand("cat a.ts")
		expect(guard.getCount("read")).toBe(0)
	})

	it("getWarnThreshold returns per-category threshold", () => {
		const guard = new BashToolGuard({ warnThresholds: { read: 2, edit: 0, write: 3, background: 5 } })
		expect(guard.getWarnThreshold("read")).toBe(2)
		expect(guard.getWarnThreshold("edit")).toBe(0)
		expect(guard.getWarnThreshold("write")).toBe(3)
		expect(guard.getWarnThreshold("background")).toBe(5)
	})

	it("classifies all four categories but only background steers", () => {
		const guard = new BashToolGuard()
		const triggerByCategory: Record<BashCategory, string> = {
			read: "cat foo.ts",
			edit: "sed -i 's/a/b/' foo.ts",
			write: "echo 'x' > foo.ts",
			background: "nohup python3 run.py &",
		}
		expect(guard.recordCommand(triggerByCategory.read)).toEqual({ decision: "allow" })
		expect(guard.recordCommand(triggerByCategory.edit)).toEqual({ decision: "allow" })
		expect(guard.recordCommand(triggerByCategory.write)).toEqual({ decision: "allow" })
		const result = guard.recordCommand(triggerByCategory.background) as BashGuardWarnResult
		expect(result.category).toBe("background")
		expect(guard.getCount("background")).toBe(1)
		expect(guard.getCount("read")).toBe(0)
	})

	it("returns user-request allow reason when explicitly requested", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("run it in the background")
		const result = guard.recordCommand("nohup python3 run.py &")
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
		guard.setLastUserPrompt("run this with nohup please")
		expect(guard.recordCommand("nohup python3 run.py &")).toEqual({
			decision: "allow",
			reason: "user-request",
		})
	})

	it("allows 'disown the job'", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("disown the job and move on")
		expect(guard.recordCommand("disown")).toEqual({ decision: "allow", reason: "user-request" })
	})

	it("allows across repeated matches when explicitly requested", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("use nohup for the server")
		expect(guard.recordCommand("nohup python3 run.py &")).toEqual({ decision: "allow", reason: "user-request" })
		expect(guard.recordCommand("nohup python3 other.py &")).toEqual({ decision: "allow", reason: "user-request" })
		expect(guard.recordCommand("nohup python3 third.py &")).toEqual({ decision: "allow", reason: "user-request" })
	})

	it("blocks when user prompt does NOT mention the tool AND has no background intent (opt-in)", () => {
		const guard = new BashToolGuard({ blockOnThreshold: true })
		guard.setLastUserPrompt("please start the analysis")
		expect(guard.recordCommand("nohup python3 run.py &").decision).toBe("warn")
		expect(guard.recordCommand("nohup python3 run2.py &").decision).toBe("block")
	})

	it("warns repeatedly when user prompt lacks explicit intent (default opt-in)", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("please start the analysis")
		expect(guard.recordCommand("nohup python3 run.py &").decision).toBe("warn")
		expect(guard.recordCommand("nohup python3 run2.py &").decision).toBe("warn")
		expect(guard.recordCommand("nohup python3 run3.py &").decision).toBe("warn")
	})

	it("uses word-boundary matching (no false positives on similar words)", () => {
		const guard = new BashToolGuard()
		// 'disown' inside 'disowned' should NOT trigger the override.
		guard.setLastUserPrompt("the disowned processes piled up")
		expect(guard.recordCommand("disown").decision).toBe("warn")
	})

	it("reset() clears the last prompt", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("use nohup for the server")
		expect(guard.recordCommand("nohup python3 run.py &")).toEqual({ decision: "allow", reason: "user-request" })
		guard.reset()
		expect(guard.recordCommand("nohup python3 run.py &").decision).toBe("warn")
	})

	it("isExplicitlyRequested returns false when no prompt set", () => {
		const guard = new BashToolGuard()
		expect(guard.isExplicitlyRequested("nohup python3 run.py")).toBe(false)
	})

	it("isExplicitlyRequested returns false for empty matchedSegment", () => {
		const guard = new BashToolGuard()
		// 'disown' would match the tool-name tier for a real segment, but
		// the semantic patterns don't match — proving the empty segment
		// neither crashes nor false-positives.
		guard.setLastUserPrompt("disown it please")
		expect(guard.isExplicitlyRequested("")).toBe(false)
	})

	it("case-insensitive matching", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("Use NOHUP for the server")
		expect(guard.recordCommand("nohup python3 run.py &")).toEqual({ decision: "allow", reason: "user-request" })
	})

	it("isExplicitlyRequested matches background semantic intent (no tool name)", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("please run it in the background")
		// Program 'nohup' is not mentioned, but the 'run ... background'
		// semantic pattern matches → still allowed.
		expect(guard.isExplicitlyRequested("nohup python3 run.py")).toBe(true)
	})

	it("getLastUserPrompt returns the lowercased prompt", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("Run It IN THE Background")
		expect(guard.getLastUserPrompt()).toBe("run it in the background")
	})
})

describe("BashToolGuard — semantic intent override (no tool name)", () => {
	// These tests verify the guard detects background intent phrases like
	// "run in the background" even when the user doesn't name the operator.

	it("'run in the background' allows nohup", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("run the server in the background")
		expect(guard.recordCommand("nohup python3 run.py &")).toEqual({ decision: "allow", reason: "user-request" })
	})

	it("'launch it detached' allows backgrounding", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("launch it detached so it survives the shell")
		expect(guard.recordCommand("sleep 60 &")).toEqual({ decision: "allow", reason: "user-request" })
	})

	it("'use nohup' allows nohup (semantic, without quotes)", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("just use nohup for the server")
		expect(guard.recordCommand("nohup python3 run.py &")).toEqual({ decision: "allow", reason: "user-request" })
	})

	it("does NOT trigger background intent for unrelated prompts", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("run the tests now")
		expect(guard.isExplicitlyRequested("nohup python3 run.py")).toBe(false)
	})

	it("'look at the build output' does not allow backgrounding", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("look at the build output")
		expect(guard.recordCommand("nohup python3 run.py &").decision).toBe("warn")
	})

	it("'please be careful' does not allow backgrounding", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("please be careful")
		expect(guard.recordCommand("sleep 60 &").decision).toBe("warn")
	})

	it("'no changes needed' does not allow backgrounding", () => {
		const guard = new BashToolGuard()
		guard.setLastUserPrompt("no changes needed")
		expect(guard.recordCommand("disown").decision).toBe("warn")
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

	it("explains the cohort contract without model timing knobs", () => {
		expect(bashToolDescription()).not.toMatch(/timeout=1800/)
		expect(bashToolDescription()).not.toMatch(/checkin_interval/)
		expect(bashToolDescription()).toContain("harness-owned safety limit")
		expect(bashToolDescription()).toContain("do not poll")
	})

	it("tells the model other tools stay available while a process runs", () => {
		expect(bashToolDescription()).toContain("other tools stay available")
	})

	it("steers the model toward independent work instead of polling bash_control", () => {
		expect(bashToolDescription()).toContain("do independent work")
		expect(bashToolDescription()).toContain("do not poll")
	})

	it("warns against commands that could conflict with a running process", () => {
		expect(bashToolDescription()).toContain("avoid commands or edits that could conflict")
	})

	it("tells the model to prefer pre-built packages over compiling from source", () => {
		expect(bashToolDescription()).toContain("prefer pre-built packages")
		expect(bashToolDescription()).toContain("over compiling from source")
		expect(bashToolDescription()).toContain("apt")
		expect(bashToolDescription()).toContain("brew")
		expect(bashToolDescription()).toContain("pip")
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
		expect(override).toContain("Managed background (bash + bash_control) is killed when the session ends.")
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

// ─────────────────────────────────────────────────────────────────────────
// Regression: config reads during the agent loop.
// The guard consults the resource store on every bash tool_call; with the
// stat-gated cache that must cost one statSync, not a read+parse per event.
// ─────────────────────────────────────────────────────────────────────────

describe("bashToolGuardExtension — stat-gated settings reads", () => {
	let dir: string
	let previousAgentDir: string | undefined

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-guard-cache-"))
		previousAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		process.env.KIMCHI_CODING_AGENT_DIR = dir
		writeFileSync(join(dir, "settings.json"), "{}", "utf-8")
		__resetJsonCacheForTest()
		settingsReads.count = 0
	})

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
		else process.env.KIMCHI_CODING_AGENT_DIR = previousAgentDir
		rmSync(dir, { recursive: true, force: true })
		__resetJsonCacheForTest()
	})

	it("consecutive tool_call events read settings.json exactly once; a change re-reads", () => {
		const { api, getHandlers } = createExtensionApi()
		bashToolGuardExtension(api)

		const event = { toolName: "bash", input: { command: "echo hello" } }
		const ctx = createContext()
		const runToolCall = () => getHandlers("tool_call").map((handler) => handler(event, ctx))

		// Two consecutive bash tool_calls consult the resource store; the
		// stat-gated cache must read (open+parse) the file exactly once.
		runToolCall()
		runToolCall()
		expect(settingsReads.count).toBe(1)

		// Mid-session disable (the /resources freshness contract): the write
		// changes the signature, so the next event re-reads and the early-out
		// applies without a restart.
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ resources: { "extensions.bash-tool-guard": false } }),
			"utf-8",
		)
		runToolCall()
		expect(settingsReads.count).toBe(2)
	})
})
