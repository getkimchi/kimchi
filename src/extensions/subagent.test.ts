import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
	RESULT_MAX_CHARS,
	buildSubagentArgs,
	logSubagentTelemetry,
	parseSubagentEvent,
	parseSubagentResponse,
	prepareChildSessionFile,
	stageFromDuration,
	stripReasoningWrappers,
	truncateSubagentResult,
	validateAttachments,
} from "./subagent.js"

describe("parseSubagentEvent", () => {
	const cases: Record<
		string,
		{
			input: string
			expected: {
				delta: string | null
				inputTokens: number
				outputTokens: number
				cacheReadTokens: number
				cacheWriteTokens: number
				toolCall: { name: string; args: Record<string, unknown> } | null
			}
		}
	> = {
		"returns delta for message_update text_delta event": {
			input: JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "hello" },
			}),
			expected: {
				delta: "hello",
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				toolCall: null,
			},
		},
		"returns empty delta string": {
			input: JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "" },
			}),
			expected: { delta: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCall: null },
		},
		"ignores message_update events that are not text_delta": {
			input: JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: "..." },
			}),
			expected: {
				delta: null,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				toolCall: null,
			},
		},
		"returns separate input and output tokens from message_end with usage": {
			input: JSON.stringify({
				type: "message_end",
				message: { usage: { input: 100, output: 40 } },
			}),
			expected: {
				delta: null,
				inputTokens: 100,
				outputTokens: 40,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				toolCall: null,
			},
		},
		"returns cache tokens from message_end with full usage": {
			input: JSON.stringify({
				type: "message_end",
				message: { usage: { input: 100, output: 40, cacheRead: 200, cacheWrite: 50 } },
			}),
			expected: {
				delta: null,
				inputTokens: 100,
				outputTokens: 40,
				cacheReadTokens: 200,
				cacheWriteTokens: 50,
				toolCall: null,
			},
		},
		"returns zero tokens from message_end without usage": {
			input: JSON.stringify({
				type: "message_end",
				message: {},
			}),
			expected: {
				delta: null,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				toolCall: null,
			},
		},
		"returns partial tokens from message_end with input only": {
			input: JSON.stringify({
				type: "message_end",
				message: { usage: { input: 50 } },
			}),
			expected: {
				delta: null,
				inputTokens: 50,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				toolCall: null,
			},
		},
		"returns tool call for tool_execution_start event": {
			input: JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "ls -la" } }),
			expected: {
				delta: null,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				toolCall: { name: "bash", args: { command: "ls -la" } },
			},
		},
		"returns tool call with empty args for tool_execution_start without args": {
			input: JSON.stringify({ type: "tool_execution_start", toolName: "read", args: null }),
			expected: {
				delta: null,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				toolCall: { name: "read", args: {} },
			},
		},
		"ignores blank lines": {
			input: "   ",
			expected: {
				delta: null,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				toolCall: null,
			},
		},
		"ignores invalid JSON": {
			input: "not json {",
			expected: {
				delta: null,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				toolCall: null,
			},
		},
	}

	for (const [name, { input, expected }] of Object.entries(cases)) {
		it(name, () => {
			expect(parseSubagentEvent(input)).toEqual(expected)
		})
	}
})

describe("validateAttachments", () => {
	let tmp: string
	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "subagent-validate-"))
		writeFileSync(join(tmp, "here.png"), "x")
		mkdirSync(join(tmp, "a-directory"))
	})
	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true })
	})

	it("returns empty resolved list when attachments is undefined", () => {
		expect(validateAttachments(undefined, tmp)).toEqual({ kind: "ok", resolved: [] })
	})

	it("returns empty resolved list when attachments is empty", () => {
		expect(validateAttachments([], tmp)).toEqual({ kind: "ok", resolved: [] })
	})

	it("resolves cwd-relative paths to absolute", () => {
		const r = validateAttachments(["here.png"], tmp)
		expect(r).toEqual({ kind: "ok", resolved: [join(tmp, "here.png")] })
	})

	it("reports missing files using the original path the caller supplied", () => {
		expect(validateAttachments(["gone.png"], tmp)).toEqual({ kind: "invalid", missing: ["gone.png"], notFile: [] })
	})

	it("lists only the missing files on partial miss", () => {
		expect(validateAttachments(["here.png", "gone.png"], tmp)).toEqual({
			kind: "invalid",
			missing: ["gone.png"],
			notFile: [],
		})
	})

	it("strips a leading @ before resolving", () => {
		const r = validateAttachments(["@here.png"], tmp)
		expect(r).toEqual({ kind: "ok", resolved: [join(tmp, "here.png")] })
	})

	it("reports a directory as not-a-file, not as missing", () => {
		expect(validateAttachments(["a-directory"], tmp)).toEqual({
			kind: "invalid",
			missing: [],
			notFile: ["a-directory"],
		})
	})

	it("buckets missing and not-a-file separately in mixed input", () => {
		expect(validateAttachments(["gone.png", "a-directory"], tmp)).toEqual({
			kind: "invalid",
			missing: ["gone.png"],
			notFile: ["a-directory"],
		})
	})

	it("rejects empty-string attachments with kind: empty", () => {
		expect(validateAttachments([""], tmp)).toEqual({ kind: "empty" })
	})

	it("rejects whitespace-only attachments with kind: empty", () => {
		expect(validateAttachments(["   "], tmp)).toEqual({ kind: "empty" })
	})

	it("rejects a lone @ (empty after strip) with kind: empty", () => {
		expect(validateAttachments(["@"], tmp)).toEqual({ kind: "empty" })
	})

	it("empty-string detection fires even alongside valid paths", () => {
		expect(validateAttachments(["here.png", ""], tmp)).toEqual({ kind: "empty" })
	})

	it("dedupes attachments that resolve to the same absolute path", () => {
		const r = validateAttachments(["here.png", "./here.png", "@here.png"], tmp)
		expect(r).toEqual({ kind: "ok", resolved: [join(tmp, "here.png")] })
	})

	it("returns the absolute path from the injected resolver in order", () => {
		const r = validateAttachments(["a", "b"], "/cwd", (p, _cwd) => `/abs/${p}`)
		expect(r).toEqual({ kind: "ok", resolved: ["/abs/a", "/abs/b"] })
	})
})

describe("buildSubagentArgs", () => {
	const base = { provider: "kimchi-dev", model: "kimi-k2.5", prompt: "go" }

	it("omits @ tokens when resolvedAttachments is empty", () => {
		const args = buildSubagentArgs(base, [], [])
		expect(args.some((a) => a.startsWith("@"))).toBe(false)
	})

	it("emits --session <path> and places attachments after extensionArgs and before prompt when a childSessionFile is provided", () => {
		const args = buildSubagentArgs(base, ["/abs/a.png", "/abs/b.txt"], ["-e", "ext-one"], "/abs/sessions/child.jsonl")
		expect(args).toEqual([
			"--mode",
			"json",
			"-p",
			"--session",
			"/abs/sessions/child.jsonl",
			"--provider",
			"kimchi-dev",
			"--model",
			"kimi-k2.5",
			"-e",
			"ext-one",
			"@/abs/a.png",
			"@/abs/b.txt",
			"go",
		])
	})

	it("falls back to --no-session when childSessionFile is omitted (in-memory parent case)", () => {
		const args = buildSubagentArgs(base, [], [])
		expect(args).toContain("--no-session")
		expect(args).not.toContain("--session")
	})

	it("passes absolute paths straight through with a single @ prefix", () => {
		const abs = resolve("/tmp/img.png")
		const args = buildSubagentArgs(base, [abs], [])
		expect(args).toContain(`@${abs}`)
		expect(args.some((a) => a.startsWith("@@"))).toBe(false)
	})
})

describe("prepareChildSessionFile", () => {
	let tmp: string

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "subagent-prewrite-"))
	})
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true })
	})

	it("returns undefined when the parent session file is undefined (in-memory parent)", () => {
		expect(prepareChildSessionFile(tmp, undefined, "/some/cwd")).toBeUndefined()
	})

	it("returns undefined when the parent session dir is empty", () => {
		expect(prepareChildSessionFile("", "/abs/parent.jsonl", "/some/cwd")).toBeUndefined()
	})

	it("writes a header-only file with correct fields and schema version", () => {
		const parentFile = join(tmp, "parent.jsonl")
		const fixedId = "01928374-5565-7abc-8def-123456789abc"
		const fixedTs = new Date("2026-04-24T10:20:30.400Z")

		const prepared = prepareChildSessionFile(
			tmp,
			parentFile,
			"/work/dir",
			() => fixedId,
			() => fixedTs,
		)

		expect(prepared).toBeDefined()
		expect(prepared?.sessionId).toBe(fixedId)
		// Filename pattern: <ISO-with-colons-and-dots-replaced>_<uuid>.jsonl in the parent session dir.
		expect(prepared?.sessionFile).toBe(join(tmp, `2026-04-24T10-20-30-400Z_${fixedId}.jsonl`))

		const contents = readFileSync(prepared?.sessionFile ?? "", "utf-8")
		expect(contents.endsWith("\n")).toBe(true)
		const lines = contents.trimEnd().split("\n")
		expect(lines).toHaveLength(1)

		const header = JSON.parse(lines[0]) as Record<string, unknown>
		expect(header).toEqual({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: fixedId,
			timestamp: fixedTs.toISOString(),
			cwd: "/work/dir",
			parentSession: parentFile,
		})
	})

	// Prompt content may contain secrets, so the header file must not be world/group-readable.
	it("writes the header file with 0o600 permissions", () => {
		const parentFile = join(tmp, "parent.jsonl")
		const prepared = prepareChildSessionFile(tmp, parentFile, "/work/dir")

		expect(prepared?.sessionFile.startsWith(tmp)).toBe(true)
		const mode = statSync(prepared?.sessionFile ?? "").mode & 0o777
		expect(mode).toBe(0o600)
	})

	it("propagates I/O errors (e.g. non-existent parent dir) so callers can surface them", () => {
		const missingDir = join(tmp, "does-not-exist")
		const parentFile = join(missingDir, "parent.jsonl")
		expect(() => prepareChildSessionFile(missingDir, parentFile, "/work/dir")).toThrow()
	})

	// Guards against regressions like caching/memoizing the id per parent, which would silently collide under fan-out.
	it("assigns a distinct sessionId to each call so parallel spawns cannot collide", () => {
		const parentFile = join(tmp, "parent.jsonl")
		const ids = Array.from({ length: 8 }, () => prepareChildSessionFile(tmp, parentFile, "/work/dir")?.sessionId)
		expect(new Set(ids).size).toBe(ids.length)
	})
})

describe("parseSubagentResponse", () => {
	const cases: Record<string, { input: string; expected: { summary: string; files: string[] } | null }> = {
		"parses clean JSON": {
			input: '{"summary": "Done.", "files": ["/docs/plan.md"]}',
			expected: { summary: "Done.", files: ["/docs/plan.md"] },
		},
		"parses JSON with no files": {
			input: '{"summary": "Task complete.", "files": []}',
			expected: { summary: "Task complete.", files: [] },
		},
		"parses JSON missing files field": {
			input: '{"summary": "Done."}',
			expected: { summary: "Done.", files: [] },
		},
		"parses JSON wrapped in code fence": {
			input: '```json\n{"summary": "Done.", "files": ["/docs/out.md"]}\n```',
			expected: { summary: "Done.", files: ["/docs/out.md"] },
		},
		"parses JSON wrapped in plain code fence": {
			input: '```\n{"summary": "Done.", "files": []}\n```',
			expected: { summary: "Done.", files: [] },
		},
		"parses JSON with leading preamble": {
			input: 'Here is my response:\n\n{"summary": "Done.", "files": ["/docs/out.md"]}',
			expected: { summary: "Done.", files: ["/docs/out.md"] },
		},
		"filters out non-string file entries": {
			input: '{"summary": "Done.", "files": ["/docs/a.md", 42, null, "/docs/b.md"]}',
			expected: { summary: "Done.", files: ["/docs/a.md", "/docs/b.md"] },
		},
		"returns null for plain text": {
			input: "I completed the task successfully.",
			expected: null,
		},
		"returns null for JSON without summary": {
			input: '{"result": "done", "files": []}',
			expected: null,
		},
		"returns null for empty string": {
			input: "",
			expected: null,
		},
	}

	for (const [name, { input, expected }] of Object.entries(cases)) {
		it(name, () => {
			expect(parseSubagentResponse(input)).toEqual(expected)
		})
	}

	// Reasoning-model behavior. Workers running minimax-m2.7, kimi-k2.5,
	// DeepSeek and other reasoning models routinely interleave <think> blocks
	// with their final answer. Without stripping, valid responses parse as
	// null and the orchestrator sees "protocol violation" — the actual root
	// cause behind ~59% of subagent failures observed in a prior session.

	it("strips <think> blocks before parsing JSON", () => {
		const input = '<think>Let me figure this out</think>\n{"summary": "Done.", "files": []}'
		expect(parseSubagentResponse(input)).toEqual({ summary: "Done.", files: [] })
	})

	it("strips <thinking> blocks before parsing JSON", () => {
		const input = '<thinking>Long reasoning here</thinking>{"summary": "OK"}'
		expect(parseSubagentResponse(input)).toEqual({ summary: "OK", files: [] })
	})

	it("strips multiple interleaved <think> blocks", () => {
		const input =
			'<think>step 1</think>\n<think>step 2</think>\n<think>final</think>\n{"summary": "Iterated.", "files": []}'
		expect(parseSubagentResponse(input)).toEqual({ summary: "Iterated.", files: [] })
	})

	it("strips a trailing unclosed <think> opener (truncated stream)", () => {
		const input = '{"summary": "Cleanup.", "files": []}\n<think>unfinished'
		expect(parseSubagentResponse(input)).toEqual({ summary: "Cleanup.", files: [] })
	})

	it("falls back to markdown-as-summary when worker returns substantive non-JSON content", () => {
		// Reasoning models that ignore the JSON protocol but still produce useful work
		// shouldn't be classified as protocol violations — the orchestrator can use the
		// content even if it isn't structured.
		const input = `# Inventory

- File: src/ferment/types.ts
  - Exports: Ferment, Phase, Step, JudgeGrade
- File: src/ferment/state-machine.ts
  - Exports: applyCommand, Command`
		const result = parseSubagentResponse(input)
		expect(result).not.toBeNull()
		expect(result?.summary).toContain("Inventory")
		expect(result?.files).toEqual([])
	})

	it("fallback truncates very long markdown responses", () => {
		const long = "x".repeat(3000)
		const result = parseSubagentResponse(long)
		expect(result).not.toBeNull()
		expect(result?.summary.length).toBeLessThanOrEqual(2100)
		expect(result?.summary).toContain("[response truncated]")
	})

	it("does NOT fall back for trivial non-JSON output", () => {
		// Short plain-text "I'm done." style responses still null out so the
		// orchestrator can decide to retry with a tighter prompt.
		expect(parseSubagentResponse("ok")).toBeNull()
		expect(parseSubagentResponse("done!")).toBeNull()
	})
})

describe("stripReasoningWrappers", () => {
	it("strips a single <think> block", () => {
		expect(stripReasoningWrappers("<think>plan</think>answer")).toBe("answer")
	})

	it("strips a single <thinking> block", () => {
		expect(stripReasoningWrappers("<thinking>plan</thinking>answer")).toBe("answer")
	})

	it("strips multiple closed blocks", () => {
		expect(stripReasoningWrappers("<think>a</think>X<think>b</think>Y")).toBe("XY")
	})

	it("drops trailing unclosed <think>", () => {
		expect(stripReasoningWrappers("answer<think>truncated...")).toBe("answer")
	})

	it("leaves text without reasoning blocks unchanged", () => {
		expect(stripReasoningWrappers("plain answer")).toBe("plain answer")
	})

	it("handles a closed block followed by an unclosed one", () => {
		expect(stripReasoningWrappers("<think>a</think>middle<think>tail")).toBe("middle")
	})
})

describe("truncateSubagentResult", () => {
	const cases: Record<
		string,
		{ text: string; sessionFile: string | undefined; expectTruncated: boolean; expectSessionRef: boolean }
	> = {
		"returns text unchanged when under limit": {
			text: "short output",
			sessionFile: undefined,
			expectTruncated: false,
			expectSessionRef: false,
		},
		"returns text unchanged at exact limit": {
			text: "x".repeat(RESULT_MAX_CHARS),
			sessionFile: undefined,
			expectTruncated: false,
			expectSessionRef: false,
		},
		"truncates text one character over limit": {
			text: "x".repeat(RESULT_MAX_CHARS + 1),
			sessionFile: undefined,
			expectTruncated: true,
			expectSessionRef: false,
		},
		"truncates and includes session file reference when provided": {
			text: "x".repeat(RESULT_MAX_CHARS + 100),
			sessionFile: "/sessions/child.jsonl",
			expectTruncated: true,
			expectSessionRef: true,
		},
		"handles empty string": {
			text: "",
			sessionFile: undefined,
			expectTruncated: false,
			expectSessionRef: false,
		},
	}

	for (const [name, { text, sessionFile, expectTruncated, expectSessionRef }] of Object.entries(cases)) {
		it(name, () => {
			const result = truncateSubagentResult(text, sessionFile)
			if (expectTruncated) {
				expect(result).toContain("[… middle elided")
				// head + elision notice + tail should stay within ~RESULT_MAX_CHARS + small overhead
				expect(result.length).toBeLessThanOrEqual(RESULT_MAX_CHARS + 200)
				// both the start and end of the original text are preserved
				const half = Math.floor(RESULT_MAX_CHARS / 2)
				expect(result).toContain(text.slice(0, half))
				expect(result).toContain(text.slice(-half))
			} else {
				expect(result).toBe(text)
			}
			if (expectSessionRef) {
				expect(result).toContain(sessionFile)
			}
		})
	}
})

describe("stageFromDuration", () => {
	it("returns early for durations < 10s", () => {
		expect(stageFromDuration(0)).toBe("early")
		expect(stageFromDuration(9_999)).toBe("early")
	})
	it("returns mid for durations >= 10s up to 5min", () => {
		expect(stageFromDuration(10_000)).toBe("mid")
		expect(stageFromDuration(60_000)).toBe("mid")
		expect(stageFromDuration(299_999)).toBe("mid")
	})
	it("returns late for durations >= 5min", () => {
		expect(stageFromDuration(300_000)).toBe("late")
		expect(stageFromDuration(1_000_000)).toBe("late")
	})
})

describe("logSubagentTelemetry", () => {
	it("creates and appends a JSONL entry when the dir exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "tm-"))
		const entry = {
			timestamp: "2026-01-01T00:00:00Z",
			model: "test-model",
			provider: "test-provider",
			tokenBudget: 100_000,
			inactivityTimeoutMs: 180_000,
			promptLength: 42,
			attachmentCount: 2,
			result: "success" as const,
			exitCode: 0,
			durationMs: 5_000,
			tokenUsage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 8 },
			outputLength: 100,
			stderrLength: 0,
			toolCallCount: 3,
			stage: "early" as const,
		}
		logSubagentTelemetry(dir, entry)

		const lines = readFileSync(join(dir, "subagent-telemetry.jsonl"), "utf-8").trim().split("\n")
		expect(lines).toHaveLength(1)
		const parsed = JSON.parse(lines[0])
		expect(parsed.model).toBe("test-model")
		expect(parsed.result).toBe("success")
		expect(parsed.toolCallCount).toBe(3)
		expect(parsed.stage).toBe("early")
		expect(parsed).toHaveProperty("timestamp")
		expect(parsed).toHaveProperty("tokenUsage")

		rmSync(dir, { recursive: true, force: true })
	})

	it("appends multiple entries without overwriting", () => {
		const dir = mkdtempSync(join(tmpdir(), "tm-"))
		const entryBase = {
			timestamp: "2026-01-01T00:00:00Z",
			model: "m",
			provider: "p",
			inactivityTimeoutMs: 100,
			promptLength: 1,
			attachmentCount: 0,
			result: "success" as const,
			exitCode: 0,
			durationMs: 0,
			tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			outputLength: 0,
			stderrLength: 0,
			toolCallCount: 0,
			stage: "early" as const,
		}
		logSubagentTelemetry(dir, entryBase)
		logSubagentTelemetry(dir, entryBase)

		const lines = readFileSync(join(dir, "subagent-telemetry.jsonl"), "utf-8").trim().split("\n")
		expect(lines).toHaveLength(2)

		rmSync(dir, { recursive: true, force: true })
	})

	it("silently does nothing when sessionDir is undefined", () => {
		const entry = {
			timestamp: "2026-01-01T00:00:00Z",
			model: "m",
			provider: "p",
			inactivityTimeoutMs: 100,
			promptLength: 1,
			attachmentCount: 0,
			result: "success" as const,
			exitCode: 0,
			durationMs: 0,
			tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			outputLength: 0,
			stderrLength: 0,
			toolCallCount: 0,
			stage: "early" as const,
		}
		expect(() => logSubagentTelemetry(undefined, entry)).not.toThrow()
	})

	it("silently swallows errors for non-writable or missing dirs", () => {
		const entry = {
			timestamp: "2026-01-01T00:00:00Z",
			model: "m",
			provider: "p",
			inactivityTimeoutMs: 100,
			promptLength: 1,
			attachmentCount: 0,
			result: "success" as const,
			exitCode: 0,
			durationMs: 0,
			tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			outputLength: 0,
			stderrLength: 0,
			toolCallCount: 0,
			stage: "early" as const,
		}
		expect(() => logSubagentTelemetry("/nonexistent/path/that/does/not/exist", entry)).not.toThrow()
	})
})
