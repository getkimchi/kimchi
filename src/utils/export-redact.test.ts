import { describe, expect, it } from "vitest"
import { REDACTED, redactDeep, redactEntries, redactSessionData, redactString } from "./export-redact.js"

describe("redactString", () => {
	it("redacts CastAI API keys (castai_v1_ prefix)", () => {
		expect(redactString("castai_v1_abc123def456")).toBe(REDACTED.token)
		expect(redactString("castai_v1_test_token_123")).toBe(REDACTED.token)
		expect(redactString("Authorization: Bearer castai_v1_secret")).toBe(`Authorization: Bearer ${REDACTED.token}`)
	})

	it("redacts OpenAI keys (sk- prefix)", () => {
		expect(redactString("sk-proj-abc123def456ghi789")).toBe(REDACTED.token)
		expect(redactString("sk-ant-api03-xxxxx")).toBe(REDACTED.token)
	})

	it("redacts GitHub tokens (ghp_/gho_/ghs_ prefix)", () => {
		expect(redactString("ghp_1234567890abcdef1234567890abcdef12345678")).toBe(REDACTED.token)
		expect(redactString("ghs_1234567890abcdef1234567890abcdef12345678")).toBe(REDACTED.token)
		expect(redactString("github_pat_1234567890abcdef")).toBe(REDACTED.token)
	})

	it("redacts Slack tokens (xox prefix)", () => {
		expect(redactString("xoxb-1234567890-abcdef")).toBe(REDACTED.token)
		expect(redactString("xoxp-1234567890-abcdef")).toBe(REDACTED.token)
	})

	it("redacts AWS access key IDs (AKIA prefix)", () => {
		expect(redactString("AKIAIOSFODNN7EXAMPLE")).toBe(REDACTED.token)
	})

	it("redacts Bearer tokens in authorization headers", () => {
		// Bearer token value is high-entropy, so it gets [REDACTED:high-entropy] or [REDACTED:token]
		// depending on length. The key point is the token value is redacted.
		expect(redactString("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toContain("REDACTED")
		expect(redactString("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).not.toContain("eyJhbGci")
		expect(redactString('"authorization":"bearer abc123def456ghi789"')).toContain("REDACTED")
		expect(redactString('"authorization":"bearer abc123def456ghi789"')).not.toContain("abc123def456")
	})

	it("redacts local auth/config paths", () => {
		expect(redactString("~/.config/kimchi/config.json")).toBe(REDACTED.path)
		expect(redactString("~/.claude/settings.json")).toBe(REDACTED.path)
		expect(redactString("/home/user/.config/kimchi/")).toBe(REDACTED.path)
		expect(redactString("/Users/test/.claude/")).toBe(REDACTED.path)
	})

	it("does not redact normal text or model names", () => {
		expect(redactString("Hello world")).toBe("Hello world")
		expect(redactString("claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514")
		expect(redactString("/Users/user/project/src/index.ts")).toBe("/Users/user/project/src/index.ts")
		expect(redactString("tool_call_abc123")).toBe("tool_call_abc123")
	})

	it("redacts high-entropy strings", () => {
		// 40-char base64 string with high entropy
		const highEntropy = "ZmxvdXJpY2VndWVzdGhlcmVhbmRvbHNoYXJkZWNyeXB0"
		expect(redactString(highEntropy)).toBe(REDACTED.highEntropy)
	})

	it("does not redact short strings or natural language", () => {
		expect(redactString("short")).toBe("short")
		expect(redactString("This is a normal sentence with spaces")).toBe("This is a normal sentence with spaces")
		expect(redactString("line1\nline2")).toBe("line1\nline2")
	})

	it("does not redact data URIs", () => {
		expect(redactString("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=")
	})

	it("handles empty strings", () => {
		expect(redactString("")).toBe("")
	})
})

describe("redactString with keyHint", () => {
	it("redacts values under sensitive keys", () => {
		expect(redactString("my-password-value", "password")).toBe(REDACTED.key)
		expect(redactString("my-token-value", "api_key")).toBe(REDACTED.key)
		expect(redactString("my-secret-value", "apikey")).toBe(REDACTED.key)
		expect(redactString("my-credential-value", "credential")).toBe(REDACTED.key)
		expect(redactString("my-auth-value", "auth")).toBe(REDACTED.key)
		expect(redactString("my-secret-value", "client_secret")).toBe(REDACTED.key)
		expect(redactString("my-token-value", "refresh_token")).toBe(REDACTED.key)
		expect(redactString("my-token-value", "access_token")).toBe(REDACTED.key)
	})

	it("redacts sensitive env var values", () => {
		expect(redactString("some-value", "KIMCHI_API_KEY")).toBe(REDACTED.env)
		expect(redactString("some-value", "CASTAI_API_KEY")).toBe(REDACTED.env)
		expect(redactString("some-value", "ANTHROPIC_AUTH_TOKEN")).toBe(REDACTED.env)
		expect(redactString("some-value", "OPENAI_API_KEY")).toBe(REDACTED.env)
	})

	it("does not redact values under safe keys", () => {
		expect(redactString("claude-sonnet-4", "model")).toBe("claude-sonnet-4")
		expect(redactString("tool_call_123", "toolName")).toBe("tool_call_123")
		expect(redactString("2024-01-01", "timestamp")).toBe("2024-01-01")
	})
})

describe("redactDeep", () => {
	it("redacts secrets in nested objects", () => {
		const obj = {
			apiKey: "castai_v1_secret123",
			model: "claude-sonnet-4",
			config: {
				token: "ghp_1234567890abcdef1234567890abcdef12345678",
				nested: {
					password: "my-password",
				},
			},
		}
		const result = redactDeep(obj)
		expect(result.apiKey).toBe(REDACTED.token)
		expect(result.model).toBe("claude-sonnet-4")
		expect(result.config.token).toBe(REDACTED.token)
		expect(result.config.nested.password).toBe(REDACTED.key)
	})

	it("redacts secrets in arrays", () => {
		const arr = ["castai_v1_secret123", "normal text", "sk-abc123def456"]
		const result = redactDeep(arr)
		expect(result[0]).toBe(REDACTED.token)
		expect(result[1]).toBe("normal text")
		expect(result[2]).toBe(REDACTED.token)
	})

	it("preserves structure of complex message objects", () => {
		const entry = {
			type: "message",
			id: "msg-001",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I called the API with key castai_v1_leaked_key" },
					{
						type: "toolCall",
						id: "call-001",
						name: "bash",
						arguments: {
							command:
								'curl -H "Authorization: Bearer ghp_1234567890abcdef1234567890abcdef12345678" https://api.example.com',
						},
					},
				],
			},
		}
		redactDeep(entry)
		expect(entry.type).toBe("message")
		expect(entry.id).toBe("msg-001")
		expect(entry.message.role).toBe("assistant")
		const textBlock = entry.message.content[0] as { text: string }
		expect(textBlock.text).toContain("REDACTED")
		expect(textBlock.text).not.toContain("castai_v1_leaked_key")
		const toolCall = entry.message.content[1] as { arguments: { command: string } }
		expect(toolCall.arguments.command).toContain("REDACTED")
		expect(toolCall.arguments.command).not.toContain("ghp_1234567890abcdef")
	})

	it("redacts auth JSON fields while preserving structure", () => {
		const data = {
			auth: { bearer: "castai_v1_token_here" },
			token: "sk-abc123",
			password: "secret123",
			normalField: "keep this",
		}
		redactDeep(data)
		expect(data.auth).toBe(REDACTED.key)
		// 'token' key with 'sk-' value: token-prefix is more specific, gets [REDACTED:token]
		expect(data.token).toBe(REDACTED.token)
		expect(data.password).toBe(REDACTED.key)
		expect(data.normalField).toBe("keep this")
	})

	it("handles null and undefined gracefully", () => {
		expect(redactDeep(null)).toBeNull()
		expect(redactDeep(undefined)).toBeUndefined()
		expect(redactDeep(42)).toBe(42)
		expect(redactDeep(true)).toBe(true)
	})

	it("handles empty objects and arrays", () => {
		expect(redactDeep({})).toEqual({})
		expect(redactDeep([])).toEqual([])
	})

	it("redacts tool result content", () => {
		const entry = {
			type: "message",
			message: {
				role: "toolResult",
				toolName: "bash",
				content: [{ type: "text", text: "API_KEY=castai_v1_leaked_in_output" }],
			},
		}
		redactDeep(entry)
		const textBlock = entry.message.content[0] as { text: string }
		expect(textBlock.text).toContain("REDACTED")
		expect(textBlock.text).not.toContain("castai_v1_leaked_in_output")
	})

	it("redacts sub-agent result text", () => {
		const entry = {
			type: "custom",
			customType: "subagents:record",
			data: {
				id: "agent-001",
				type: "Explore",
				status: "completed",
				result: "Found API key castai_v1_in_result_text in the codebase",
				error: undefined,
			},
		}
		redactDeep(entry)
		const data = entry.data as { result: string }
		expect(data.result).toContain("REDACTED")
		expect(data.result).not.toContain("castai_v1_in_result_text")
	})
})

describe("redactEntries", () => {
	it("redacts secrets across multiple entries", () => {
		const entries = [
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "Use key castai_v1_abc" }] },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							name: "write",
							arguments: { path: "/tmp/config.json", content: '{"token":"sk-leaked"}' },
						},
					],
				},
			},
		]
		redactEntries(entries)
		const userText = entries[0].message.content[0] as { text: string }
		expect(userText.text).toContain("REDACTED")
		const toolCall = entries[1].message.content[0] as {
			arguments: { content: string }
		}
		// The content string itself is JSON — redactDeep walks it as a string,
		// and the sk- prefix inside the JSON string gets caught
		expect(toolCall.arguments.content).toContain("REDACTED")
	})
})

describe("redactSessionData", () => {
	it("redacts entries, systemPrompt, and tools", () => {
		const data = {
			header: { type: "session", id: "sess-001" },
			entries: [
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "castai_v1_secret_here" }] },
				},
			],
			systemPrompt: "You are an agent. API key is sk-abc123def456",
			tools: [{ name: "bash", description: "Run shell command" }],
		}
		redactSessionData(data)
		const textBlock = data.entries[0].message.content[0] as { text: string }
		expect(textBlock.text).toContain("REDACTED")
		expect(data.systemPrompt).toContain("REDACTED")
		expect(data.systemPrompt).not.toContain("sk-abc123def456")
	})
})
