import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import sessionModeOnboardingExtension, {
	buildSessionModeLaunchContext,
	decideSessionModeOnboarding,
	recordSessionModeWizardOutcome,
	type SessionModeLaunchContext,
	type SessionModeOnboardingDecision,
} from "./session-mode.js"

const interactive = { stdinIsTTY: true, stdoutIsTTY: true, isAcpMode: false }

function launch(rawArgs: string[], overrides: Partial<typeof interactive> = {}): SessionModeLaunchContext {
	return buildSessionModeLaunchContext(rawArgs, { ...interactive, ...overrides })
}

function decide(
	rawArgs: string[],
	overrides: Partial<Parameters<typeof decideSessionModeOnboarding>[0]> = {},
): SessionModeOnboardingDecision {
	return decideSessionModeOnboarding({
		launchContext: launch(rawArgs),
		hasUI: true,
		sessionStartReason: "startup",
		...overrides,
	})
}

describe("buildSessionModeLaunchContext", () => {
	it("classifies a plain interactive launch as eligible launch context", () => {
		expect(launch([])).toEqual({
			stdinIsTTY: true,
			stdoutIsTTY: true,
			automationMode: false,
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
		expect(launch(args).automationMode).toBe(true)
	})

	it("uses Kimchi's ACP pre-dispatch sniff", () => {
		expect(launch(["--mode", "acp"], { isAcpMode: true }).automationMode).toBe(true)
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
	it("shows on first plain interactive startup", () => {
		expect(decide([])).toEqual({ action: "show", reason: "eligible" })
	})

	it("skips when the wizard was already seen", () => {
		expect(decide([], { seenAt: "2026-05-19T08:00:00.000Z" })).toEqual({
			action: "skip",
			reason: "already-seen",
		})
	})

	it("marks an explicit prompt launch as Default-session intent", () => {
		expect(decide(["fix tests"])).toEqual({ action: "skip-and-mark-seen", reason: "explicit-default-session" })
	})

	it.each([
		{ args: ["--print", "fix tests"], expected: { action: "skip", reason: "automation-mode" } },
		{ args: ["--mode", "json"], expected: { action: "skip", reason: "automation-mode" } },
		{ args: ["--continue"], expected: { action: "skip", reason: "explicit-session" } },
	])("skips for $args", ({ args, expected }) => {
		expect(decide(args)).toEqual(expected as SessionModeOnboardingDecision)
	})

	it("skips without marking when UI is unavailable", () => {
		expect(decide(["fix tests"], { hasUI: false })).toEqual({ action: "skip", reason: "not-interactive-tty" })
	})

	it("skips without marking in piped stdin mode", () => {
		expect(decide(["fix tests"], { launchContext: launch(["fix tests"], { stdinIsTTY: false }) })).toEqual({
			action: "skip",
			reason: "not-interactive-tty",
		})
	})

	it("skips non-startup session_start events", () => {
		expect(decide([], { sessionStartReason: "resume" })).toEqual({ action: "skip", reason: "explicit-session" })
	})
})

describe("session-mode onboarding persistence", () => {
	let tempDir: string
	let configPath: string
	const now = () => new Date("2026-05-19T09:30:00.000Z")

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-session-mode-onboarding-"))
		configPath = join(tempDir, "config.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it.each(["default", "ferment"] as const)("marks %s choices as seen", (outcome) => {
		const seenAt = recordSessionModeWizardOutcome(outcome, { configPath, now })
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))

		expect(seenAt).toBe("2026-05-19T09:30:00.000Z")
		expect(raw.onboarding.sessionModeWizardSeenAt).toBe("2026-05-19T09:30:00.000Z")
	})

	it("does not mark cancellation as seen", () => {
		const seenAt = recordSessionModeWizardOutcome("cancelled", { configPath, now })

		expect(seenAt).toBeUndefined()
		expect(existsSync(configPath)).toBe(false)
	})

	it("extension marks explicit Default-session launches on startup", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
		const api = {
			on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, handler)
			}),
		}
		sessionModeOnboardingExtension({ launchContext: launch(["fix tests"]), configPath, now })(
			api as unknown as Parameters<ReturnType<typeof sessionModeOnboardingExtension>>[0],
		)

		await handlers.get("session_start")?.({ reason: "startup" }, { hasUI: true })

		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.onboarding.sessionModeWizardSeenAt).toBe("2026-05-19T09:30:00.000Z")
	})
})
