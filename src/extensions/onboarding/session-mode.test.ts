import { describe, expect, it } from "vitest"
import {
	type SessionModeLaunchContext,
	type SessionModeOnboardingDecision,
	buildSessionModeLaunchContext,
	decideSessionModeOnboarding,
} from "./session-mode.js"

const interactive = { stdinIsTTY: true, stdoutIsTTY: true, nonInteractiveMode: false }

function launch(rawArgs: string[], overrides: Partial<typeof interactive> = {}): SessionModeLaunchContext {
	return buildSessionModeLaunchContext(rawArgs, { ...interactive, ...overrides })
}

describe("buildSessionModeLaunchContext", () => {
	it("classifies a plain interactive launch as eligible launch context", () => {
		expect(launch([])).toEqual({
			stdinIsTTY: true,
			stdoutIsTTY: true,
			nonInteractiveMode: false,
			explicitSession: false,
			explicitDefaultIntent: false,
		})
	})

	it.each([
		{ args: ["fix tests"], label: "initial CLI message" },
		{ args: ["@prompt.md"], label: "@file argument" },
		{ args: ["--model", "cast/gpt-5", "fix tests"], label: "message after valued flag" },
	])("detects $label as explicit Default-session intent", ({ args }) => {
		expect(launch(args).explicitDefaultIntent).toBe(true)
	})

	it.each([
		["--print", "fix tests"],
		["--mode", "json", "fix tests"],
		["--mode", "rpc"],
	])("detects automation mode for %s", (...args) => {
		expect(launch(args).nonInteractiveMode).toBe(true)
	})

	it("uses Kimchi's non-interactive pre-dispatch classification", () => {
		expect(launch(["--mode", "acp"], { nonInteractiveMode: true }).nonInteractiveMode).toBe(true)
	})

	it.each([["--continue"], ["-c"], ["--resume"], ["--session", "abc123"], ["--fork", "abc123"]])(
		"detects explicit session launch for %s",
		(...args) => {
			expect(launch(args).explicitSession).toBe(true)
		},
	)

	it("does not treat unknown extension flag values as initial messages", () => {
		expect(launch(["--custom-flag", "value"]).explicitDefaultIntent).toBe(false)
	})
})

describe("decideSessionModeOnboarding", () => {
	it("skips on plain interactive startup", () => {
		expect(
			decideSessionModeOnboarding({
				launchContext: launch([]),
				hasUI: true,
				sessionStartReason: "startup",
			}),
		).toEqual({ action: "skip", reason: "default-chat" })
	})

	it("marks an explicit prompt launch as Default-session intent", () => {
		expect(
			decideSessionModeOnboarding({
				launchContext: launch(["fix tests"]),
				hasUI: true,
				sessionStartReason: "startup",
			}),
		).toEqual({ action: "skip", reason: "explicit-default-session" })
	})

	it.each([
		{ args: ["--print", "fix tests"], expected: { action: "skip", reason: "automation-mode" } },
		{ args: ["--mode", "json"], expected: { action: "skip", reason: "automation-mode" } },
		{ args: ["--continue"], expected: { action: "skip", reason: "explicit-session" } },
	])("skips for $args", ({ args, expected }) => {
		expect(
			decideSessionModeOnboarding({
				launchContext: launch(args),
				hasUI: true,
				sessionStartReason: "startup",
			}),
		).toEqual(expected as SessionModeOnboardingDecision)
	})

	it("skips without marking when UI is unavailable", () => {
		expect(
			decideSessionModeOnboarding({
				launchContext: launch(["fix tests"]),
				hasUI: false,
				sessionStartReason: "startup",
			}),
		).toEqual({ action: "skip", reason: "not-interactive-tty" })
	})

	it("skips without marking in piped stdin mode", () => {
		expect(
			decideSessionModeOnboarding({
				launchContext: launch(["fix tests"], { stdinIsTTY: false }),
				hasUI: true,
				sessionStartReason: "startup",
			}),
		).toEqual({ action: "skip", reason: "not-interactive-tty" })
	})

	it("skips non-startup session_start events", () => {
		expect(
			decideSessionModeOnboarding({
				launchContext: launch([]),
				hasUI: true,
				sessionStartReason: "resume",
			}),
		).toEqual({ action: "skip", reason: "explicit-session" })
	})
})
