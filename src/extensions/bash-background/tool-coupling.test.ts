/**
 * Unit tests for the `--tools` allowlist coupling
 * (./tool-coupling.ts): allowing `bash` also allows `bash_control`.
 *
 * The resolution must mirror upstream pi's semantics exactly, because the
 * appended list becomes `AgentSessionConfig.allowedToolNames`:
 * comma-separated entries, `+name`/`-name` modifier lists (no allowlist),
 * lists pi rejects (no allowlist), and `*` patterns per
 * `createToolNameMatcher`. The argv rewriter must mirror pi's parse walk:
 * last `--tools` wins, `--` terminates, value-taking flags consume their
 * follower, unknown flags consume only non-dash followers.
 */
import { describe, expect, it } from "vitest"
import {
	coupleBashControlToolArg,
	createToolNameMatcher,
	isInvalidToolList,
	parseToolListValue,
	resolveBashControlCoupling,
} from "./tool-coupling.js"

describe("parseToolListValue", () => {
	it("splits, trims, and drops empty entries the way pi's parser does", () => {
		expect(parseToolListValue("read, bash ,write,,")).toEqual(["read", "bash", "write"])
	})

	it("keeps pattern entries intact", () => {
		expect(parseToolListValue("bash*,read")).toEqual(["bash*", "read"])
	})
})

describe("createToolNameMatcher (pi semantics)", () => {
	it("matches exact names", () => {
		const matches = createToolNameMatcher(["read", "bash"])
		expect(matches("bash")).toBe(true)
		expect(matches("bash_control")).toBe(false)
	})

	it("matches * patterns across the whole name", () => {
		const matches = createToolNameMatcher(["bash*"])
		expect(matches("bash")).toBe(true)
		expect(matches("bash_control")).toBe(true)
	})

	it("escapes regex metacharacters in pattern segments", () => {
		const matches = createToolNameMatcher(["mcp__srv__tool.1*"])
		expect(matches("mcp__srv__tool.1x")).toBe(true)
		expect(matches("mcp__srv__toolX1x")).toBe(false)
	})
})

describe("isInvalidToolList", () => {
	it("accepts plain name lists and all-modifier lists", () => {
		expect(isInvalidToolList(["read", "bash"])).toBe(false)
		expect(isInvalidToolList(["+bash", "-write"])).toBe(false)
	})

	it("rejects mixed name/modifier lists and pattern modifiers (pi drops the flag)", () => {
		expect(isInvalidToolList(["bash", "+codemode"])).toBe(true)
		expect(isInvalidToolList(["-bash*"])).toBe(true)
	})
})

describe("resolveBashControlCoupling", () => {
	it("appends bash_control when the allowlist admits bash but not its companion", () => {
		expect(resolveBashControlCoupling(["read", "bash", "write", "grep", "find", "ls"], undefined)).toEqual({
			appendTools: ["bash_control"],
			appendExclusions: [],
		})
	})

	it("does not couple without an explicit allowlist (no --tools, modifier lists, rejected lists)", () => {
		expect(resolveBashControlCoupling(undefined, undefined)).toEqual({ appendTools: [], appendExclusions: [] })
		expect(resolveBashControlCoupling([], undefined)).toEqual({ appendTools: [], appendExclusions: [] })
		expect(resolveBashControlCoupling(["+bash"], undefined)).toEqual({ appendTools: [], appendExclusions: [] })
		expect(resolveBashControlCoupling(["bash", "+codemode"], undefined)).toEqual({
			appendTools: [],
			appendExclusions: [],
		})
	})

	it("does not couple when bash itself is not admitted", () => {
		expect(resolveBashControlCoupling(["read", "write"], undefined)).toEqual({ appendTools: [], appendExclusions: [] })
	})

	it("does not couple when the allowlist already admits bash_control (exact or pattern)", () => {
		expect(resolveBashControlCoupling(["read", "bash", "bash_control"], undefined)).toEqual({
			appendTools: [],
			appendExclusions: [],
		})
		expect(resolveBashControlCoupling(["read", "bash*"], undefined)).toEqual({ appendTools: [], appendExclusions: [] })
	})

	it("excluding bash_control also excludes bash — the pair is all-or-nothing", () => {
		// With an allowlist: nothing is appended to it; bash joins the denylist.
		expect(resolveBashControlCoupling(["read", "bash"], ["bash_control"])).toEqual({
			appendTools: [],
			appendExclusions: ["bash"],
		})
		// Without an allowlist (default tools): the denylist still extends.
		expect(resolveBashControlCoupling(undefined, ["bash_control"])).toEqual({
			appendTools: [],
			appendExclusions: ["bash"],
		})
		// Pattern exclusions are coupled the same way.
		expect(resolveBashControlCoupling(undefined, ["bash_c*"])).toEqual({
			appendTools: [],
			appendExclusions: ["bash"],
		})
	})

	it("excluding bash also excludes bash_control", () => {
		expect(resolveBashControlCoupling(["read", "bash"], ["bash"])).toEqual({
			appendTools: [],
			appendExclusions: ["bash_control"],
		})
		expect(resolveBashControlCoupling(undefined, ["bash"])).toEqual({
			appendTools: [],
			appendExclusions: ["bash_control"],
		})
	})

	it("excluding the whole pair at once needs no extension", () => {
		expect(resolveBashControlCoupling(undefined, ["bash", "bash_control"])).toEqual({
			appendTools: [],
			appendExclusions: [],
		})
		expect(resolveBashControlCoupling(undefined, ["bash*"])).toEqual({
			appendTools: [],
			appendExclusions: [],
		})
	})

	it("an unrelated exclusion does not suppress the allowlist coupling", () => {
		expect(resolveBashControlCoupling(["read", "bash"], ["write"])).toEqual({
			appendTools: ["bash_control"],
			appendExclusions: [],
		})
	})

	it("keeps the coupling when the allowlist also filters MCP tools", () => {
		expect(resolveBashControlCoupling(["read", "bash", "mcp__srv__*"], undefined)).toEqual({
			appendTools: ["bash_control"],
			appendExclusions: [],
		})
	})
})

describe("coupleBashControlToolArg", () => {
	it("extends the --tools value when coupling applies", () => {
		const args = ["--print", "--tools", "read,bash,write", "--model", "m"]
		expect(coupleBashControlToolArg(args)).toEqual([
			"--print",
			"--tools",
			"read,bash,write,bash_control",
			"--model",
			"m",
		])
	})

	it("supports the -t short form", () => {
		expect(coupleBashControlToolArg(["-t", "bash", "-p"])).toEqual(["-t", "bash,bash_control", "-p"])
	})

	it("returns the same array identity when nothing changes", () => {
		const args = ["--tools", "read,write"]
		expect(coupleBashControlToolArg(args)).toBe(args)
		const none = ["--print"]
		expect(coupleBashControlToolArg(none)).toBe(none)
	})

	it("uses the LAST --tools occurrence (later flags overwrite earlier ones, like pi)", () => {
		expect(coupleBashControlToolArg(["--tools", "read", "--tools", "bash"])).toEqual([
			"--tools",
			"read",
			"--tools",
			"bash,bash_control",
		])
	})

	it("honors --exclude-tools by extending it to the whole pair", () => {
		// Excluding the control tool removes bash too — they are one tool.
		expect(coupleBashControlToolArg(["--tools", "read,bash", "--exclude-tools", "bash_control"])).toEqual([
			"--tools",
			"read,bash",
			"--exclude-tools",
			"bash_control,bash",
		])
		// And the reverse: excluding bash removes bash_control.
		expect(coupleBashControlToolArg(["--exclude-tools", "bash"])).toEqual(["--exclude-tools", "bash,bash_control"])
		// A denylist alone (no --tools) is coupled too.
		expect(coupleBashControlToolArg(["--print", "-xt", "bash_control"])).toEqual([
			"--print",
			"-xt",
			"bash_control,bash",
		])
	})

	it("does not rewrite tokens after -- (prompt messages)", () => {
		const args = ["--print", "--", "--tools", "read,bash"]
		expect(coupleBashControlToolArg(args)).toBe(args)
	})

	it("does not mistake a value of another flag for a --tools flag", () => {
		// pi consumes the token after --model unconditionally, even when it
		// looks like a flag: --model's value is "--tools" here and "bash"
		// becomes a prompt message.
		const args = ["--model", "--tools", "bash"]
		expect(coupleBashControlToolArg(args)).toBe(args)
	})

	it("does not mistake unknown-flag values for flags", () => {
		// Unknown long flags consume a follower that is not - or @ prefixed.
		const args = ["--bash-process-limit", "60", "--tools", "bash"]
		expect(coupleBashControlToolArg(args)).toEqual(["--bash-process-limit", "60", "--tools", "bash,bash_control"])
		// A --flag=value unknown flag is self-contained.
		expect(coupleBashControlToolArg(["--flag=value", "--tools", "bash"])).toEqual([
			"--flag=value",
			"--tools",
			"bash,bash_control",
		])
	})

	it("treats --mode as consuming a non-dash follower", () => {
		expect(coupleBashControlToolArg(["--mode", "json", "--tools", "bash"])).toEqual([
			"--mode",
			"json",
			"--tools",
			"bash,bash_control",
		])
		// --mode with a dash-prefixed follower does NOT consume it.
		const args = ["--mode", "-t", "bash"]
		expect(coupleBashControlToolArg(args)).toEqual(["--mode", "-t", "bash,bash_control"])
	})

	it("ignores a trailing --tools without a value (pi requires i + 1 < length)", () => {
		const args = ["--tools"]
		expect(coupleBashControlToolArg(args)).toBe(args)
	})

	it("preserves spacing inside the value (pi trims on split)", () => {
		expect(coupleBashControlToolArg(["--tools", "read, bash"])).toEqual(["--tools", "read, bash,bash_control"])
	})
})
