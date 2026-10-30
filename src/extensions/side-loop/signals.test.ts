import { describe, expect, it } from "vitest"
import { deploySignal, messageSignal, parsePullRequestUrl, pullRequestSignal, testSignal } from "./signals.js"

const out = (text: string) => ({ content: [{ type: "text", text }] })

describe("pullRequestSignal", () => {
	it("creates a PR signal from gh pr create output", () => {
		const signals = pullRequestSignal(
			"bash",
			{ command: "git push && gh pr create --fill" },
			out("https://github.com/acme/widgets/pull/42\n"),
			false,
		)
		expect(signals).toEqual([
			{
				kind: "pr",
				created: true,
				pr: { host: "github", url: "https://github.com/acme/widgets/pull/42", repo: "acme/widgets", number: 42 },
			},
		])
	})

	it("parses GitLab merge request URLs", () => {
		expect(parsePullRequestUrl("https://gitlab.com/group/sub/proj/-/merge_requests/7")).toEqual({
			host: "gitlab",
			url: "https://gitlab.com/group/sub/proj/-/merge_requests/7",
			repo: "group/sub/proj",
			number: 7,
		})
	})
})

describe("pullRequestSignal ignores non-creating calls", () => {
	it.each([
		["a failed create", "bash", { command: "gh pr create" }, true],
		["reading a PR", "bash", { command: "gh pr view 42" }, false],
		["a non-shell tool", "read", { path: "x" }, false],
	])("%s", (_name, tool, args, isError) => {
		expect(pullRequestSignal(tool, args, out("https://github.com/a/b/pull/1"), isError)).toEqual([])
	})
})

describe("testSignal", () => {
	it("counts vitest failures", () => {
		expect(testSignal("bash", { command: "pnpm test" }, out("Tests  1 failed | 41 passed (42)"), true)).toEqual([
			{ kind: "tests", command: "pnpm test", passed: 41, failed: 1, ok: false },
		])
	})

	it("reports a passing run", () => {
		expect(testSignal("bash", { command: "pytest -q" }, out("== 10 passed in 0.3s =="), false)[0]).toMatchObject({
			passed: 10,
			ok: true,
		})
	})
})

describe("deploySignal and messageSignal", () => {
	it("picks the live URL from a helm upgrade", () => {
		expect(
			deploySignal("bash", { command: "helm upgrade api ./chart" }, out("URL: https://stg.acme.dev"), false),
		).toEqual([
			{ kind: "deploy", command: "helm upgrade api ./chart", target: "helm", url: "https://stg.acme.dev", ok: true },
		])
	})

	it("turns a Slack post into a message signal", () => {
		expect(messageSignal("slack_post_message", { channel: "#be", text: "hi" }, out("ok"), false)).toEqual([
			{ kind: "message", service: "slack", channel: "#be", text: "hi", direction: "sent" },
		])
	})
})
