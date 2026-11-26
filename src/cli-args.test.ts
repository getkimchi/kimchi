import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { parseArgs as parsePiArgs } from "@earendil-works/pi-coding-agent"
import ts from "typescript"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	applyDebugPromptsOptOut,
	CACHEABLE_OPTION_NAMES,
	CLI_OPTIONS,
	dropRetiredMultiModelArg,
	fermentLegacyFlagError,
	getCliModeArg,
	getParsedCliArgs,
	hasFermentOneshotArg,
	hasInitGitArg,
	isCliAtFileArg,
	isExperimentalFeaturesArg,
	isHelpOrVersionArgs,
	isPreDispatchValueFlag,
	isProtocolOrPrintMode,
	isTerminalUiMode,
	normalizeBooleanFlagArgs,
	normalizeResumeIdArgs,
	parseCliArgs,
	populateCliArgs,
	resolveBashProcessLimitSeconds,
	stripExperimentalFeaturesArg,
} from "./cli-args.js"
import { FERMENT_LEGACY_RESOURCE_ID } from "./extensions/ferment/resource.js"
import { DANGEROUS_BYPASS_FLAG } from "./extensions/permissions/constants.js"
import { normalizeAtFileArgs } from "./fs-paths.js"
import { resetOrgPolicyForTests } from "./org-policy.js"
import { setOrgPolicyForTests } from "./org-policy.test-utils.js"

describe("value-flag parsing", () => {
	// Short aliases must consume their value too, or the token after them is
	// parsed as a model selection and silently suppresses the Auto default.
	it.each([
		["-t", "--model"],
		["-e", "--model"],
	])("leaves the model unset when %s consumes a flag-shaped value", (...args) => {
		populateCliArgs(args)
		expect(getParsedCliArgs().options.model).toBeUndefined()
		populateCliArgs([])
	})

	it("caches only an explicitly supplied model scope", () => {
		populateCliArgs(["--models", "kimchi-dev/auto,kimchi-dev/glm-5.3"])
		expect(getParsedCliArgs().options.models).toBe("kimchi-dev/auto,kimchi-dev/glm-5.3")
		populateCliArgs([])
		expect(getParsedCliArgs().options.models).toBeUndefined()
	})
})

describe("review writer limit parsing", () => {
	it("preserves a negative equals-form value for structured validation", () => {
		expect(parseCliArgs(["--review-writer-limit=-1"]).options["review-writer-limit"]).toBe("-1")
	})
})

describe("getCliModeArg", () => {
	it("reads --mode value", () => {
		expect(getCliModeArg(["--model", "cast/gpt-5", "--mode", "json"])).toBe("json")
	})

	it("reads --mode=value", () => {
		expect(getCliModeArg(["--mode=rpc"])).toBe("rpc")
	})

	it("reads ACP mode for early CLI routing", () => {
		expect(getCliModeArg(["--mode", "acp"])).toBe("acp")
	})

	it("returns undefined when mode is absent or missing a value", () => {
		expect(getCliModeArg([])).toBeUndefined()
		expect(getCliModeArg(["--mode"])).toBeUndefined()
	})
})

describe("isHelpOrVersionArgs", () => {
	it.each([["--help"], ["-h"], ["--version"], ["-v"]])("detects %s", (arg) => {
		expect(isHelpOrVersionArgs([arg])).toBe(true)
	})

	it("returns false without help or version flags", () => {
		expect(isHelpOrVersionArgs(["--mode", "json"])).toBe(false)
	})
})

describe("isProtocolOrPrintMode", () => {
	it.each([
		["pi rpc mode", ["--mode", "rpc"]],
		["pi json mode", ["--mode", "json"]],
		["pi print mode", ["--print", "hello"]],
		["pi short print mode", ["-p", "hello"]],
		["raw equals mode fallback", ["--mode=rpc"]],
		["kimchi acp mode", ["--mode", "acp"]],
	])("returns true for %s", (_name, args) => {
		expect(isProtocolOrPrintMode(args)).toBe(true)
	})

	it("returns false for interactive invocations", () => {
		expect(isProtocolOrPrintMode([])).toBe(false)
		expect(isProtocolOrPrintMode(["fix tests"])).toBe(false)
	})
})

describe("isTerminalUiMode", () => {
	const tty = { stdinIsTTY: true, stdoutIsTTY: true }

	it("returns true for an interactive terminal invocation", () => {
		expect(isTerminalUiMode([], tty)).toBe(true)
	})

	it.each([
		["--mode", "acp"],
		["--mode", "rpc"],
		["--mode=json"],
		["--print"],
		["-p"],
	])("returns false for protocol or print args %j", (...args) => {
		expect(isTerminalUiMode(args, tty)).toBe(false)
	})

	it("returns false when stdin or stdout is not a TTY", () => {
		expect(isTerminalUiMode([], { stdinIsTTY: false, stdoutIsTTY: true })).toBe(false)
		expect(isTerminalUiMode([], { stdinIsTTY: true, stdoutIsTTY: false })).toBe(false)
	})
})

describe("pi value flags that precede a Kimchi permission boolean", () => {
	it.each([
		[["--name", "--yolo", "fix"]],
		[["-n", "--auto", "fix"]],
		[["--session-id", "--plan", "fix"]],
	])("consumes the boolean as the option value for %j", (args) => {
		expect(parseCliArgs(args).options).toEqual({})
	})
})

describe("isPreDispatchValueFlag", () => {
	it.each([
		["--provider"],
		["--model"],
		["--api-key"],
		["--system-prompt"],
		["--append-system-prompt"],
		["--session"],
		["--fork"],
		["--session-dir"],
		["--models"],
		["--tools"],
		["-t"],
		["--thinking"],
		["--export"],
		["--extension"],
		["-e"],
		["--skill"],
		["--prompt-template"],
		["--theme"],
		["--name"],
		["-n"],
		["--session-id"],
	])("detects %s as consuming a value during pre-dispatch scans", (arg) => {
		expect(isPreDispatchValueFlag(arg)).toBe(true)
	})

	it.each([
		["--continue"],
		["--resume"],
		["--no-tools"],
		["--no-themes"],
		["fix tests"],
	])("does not treat %s as a value flag", (arg) => {
		expect(isPreDispatchValueFlag(arg)).toBe(false)
	})
})

describe("normalizeResumeIdArgs", () => {
	it.each([
		[
			["-r", "019f1780-8034-7435-85aa-3e86037676ee"],
			["--session", "019f1780-8034-7435-85aa-3e86037676ee"],
		],
		[
			["--resume", "019f1780-8034-7435-85aa-3e86037676ee"],
			["--session", "019f1780-8034-7435-85aa-3e86037676ee"],
		],
		[
			["--provider", "fake", "-r", "./session.jsonl"],
			["--provider", "fake", "--session", "./session.jsonl"],
		],
		[["--resume=abc123"], ["--session", "abc123"]],
		[["-rabc123"], ["--session", "abc123"]],
	])("rewrites %j to %j", (input, expected) => {
		expect(normalizeResumeIdArgs(input)).toEqual(expected)
	})

	it.each([
		[["-r"]],
		[["--resume"]],
		[["-r", "--model", "fake"]],
		[["-r", "continue the review"]],
	])("leaves bare resume picker args unchanged", (input) => {
		expect(normalizeResumeIdArgs(input)).toEqual(input)
	})
})

describe("isCliAtFileArg", () => {
	it("does not treat known option values as @file attachments", () => {
		expect(isCliAtFileArg("@literal", 1, ["--system-prompt", "@literal"])).toBe(false)
		expect(isCliAtFileArg("@scope/pkg", 1, ["--extension", "@scope/pkg"])).toBe(false)
		expect(isCliAtFileArg("@release", 1, ["--name", "@release"])).toBe(false)
	})

	it("uses parser position instead of matching @ values by text", () => {
		const args = ["--name", "@same", "@same"]

		expect(isCliAtFileArg("@same", 1, args)).toBe(false)
		expect(isCliAtFileArg("@same", 2, args)).toBe(true)
	})

	it("still treats standalone @file args as attachments", () => {
		expect(isCliAtFileArg("@prompt.md", 0, ["@prompt.md"])).toBe(true)
		expect(isCliAtFileArg("@prompt.md", 1, ["--print", "@prompt.md"])).toBe(true)
	})
})

describe("normalizeAtFileArgs with CLI parsing", () => {
	it("leaves @-prefixed option values unchanged", () => {
		const tmp = mkdtempSync(join(tmpdir(), "cli-at-file-args-"))
		try {
			mkdirSync(join(tmp, "literal"))
			mkdirSync(join(tmp, "scope", "pkg"), { recursive: true })
			writeFileSync(join(tmp, "prompt.md"), "hi")

			const result = normalizeAtFileArgs(
				["--system-prompt", "@literal", "--extension", "@scope/pkg", "@prompt.md"],
				tmp,
				isCliAtFileArg,
			)

			expect(result.args).toEqual([
				"--system-prompt",
				"@literal",
				"--extension",
				"@scope/pkg",
				`@${join(tmp, "prompt.md")}`,
			])
			expect(result.directoryArgs).toEqual([])
		} finally {
			rmSync(tmp, { recursive: true, force: true })
		}
	})
})

describe("isExperimentalFeaturesArg", () => {
	it("returns true when flag is present", () => {
		expect(isExperimentalFeaturesArg(["--enable-experimental-features"])).toBe(true)
	})

	it("returns true when mixed with other args", () => {
		expect(isExperimentalFeaturesArg(["--model", "foo", "--enable-experimental-features"])).toBe(true)
	})

	it("returns false when flag is absent", () => {
		expect(isExperimentalFeaturesArg(["--model", "foo"])).toBe(false)
	})

	it("returns false for empty args", () => {
		expect(isExperimentalFeaturesArg([])).toBe(false)
	})
})

describe("hasFermentOneshotArg (Chunk 7 gate composition)", () => {
	it.each([
		[["--ferment-oneshot"], true],
		[["--ferment-oneshot=true"], true],
		[["--ferment-oneshot=false"], false],
		[["--print"], false],
	])("agrees with the parsed value for %j", (args, expected) => {
		expect(() => parseCliArgs(args)).not.toThrow()
		expect(hasFermentOneshotArg(args)).toBe(expected)
	})

	it("returns true for the bare flag", () => {
		expect(hasFermentOneshotArg(["--ferment-oneshot"])).toBe(true)
	})

	it("returns true for the kwarg form", () => {
		expect(hasFermentOneshotArg(["ferment-oneshot=true"])).toBe(true)
		expect(hasFermentOneshotArg(["--print", "ferment-oneshot=true"])).toBe(true)
	})

	it("returns true when mixed with other args", () => {
		expect(hasFermentOneshotArg(["--model", "foo", "--print", "--ferment-oneshot"])).toBe(true)
	})

	it("returns false when absent", () => {
		expect(hasFermentOneshotArg(["--print"])).toBe(false)
		expect(hasFermentOneshotArg([])).toBe(false)
	})

	it("returns false when the suffix appears inside an unrelated flag", () => {
		expect(hasFermentOneshotArg(["--foo-ferment-oneshot=true"])).toBe(false)
	})
})

describe("stripExperimentalFeaturesArg", () => {
	it("removes the flag from the array", () => {
		expect(stripExperimentalFeaturesArg(["--enable-experimental-features", "--model", "foo"])).toEqual([
			"--model",
			"foo",
		])
	})

	it("removes all occurrences", () => {
		expect(stripExperimentalFeaturesArg(["--enable-experimental-features", "--enable-experimental-features"])).toEqual(
			[],
		)
	})

	it("returns the array unchanged when flag is absent", () => {
		expect(stripExperimentalFeaturesArg(["--model", "foo"])).toEqual(["--model", "foo"])
	})

	it("returns empty array for empty input", () => {
		expect(stripExperimentalFeaturesArg([])).toEqual([])
	})
})

describe("dropRetiredMultiModelArg", () => {
	// Kimchi Studio launches new terminal sessions this way; they must start
	// on the default model instead of failing with "model not found".
	it.each([
		[
			["--model", "multi-model", "--plan", "fix it"],
			["--plan", "fix it"],
		],
		[["--model=multi-model", "--plan"], ["--plan"]],
	])("drops %j", (args, expected) => {
		expect(dropRetiredMultiModelArg(args)).toEqual(expected)
		expect(parseCliArgs(dropRetiredMultiModelArg(args)).options.model).toBeUndefined()
	})

	it("keeps real model selections", () => {
		const args = ["--model", "kimchi-dev/deepseek-v4.1-flash", "multi-model"]
		expect(dropRetiredMultiModelArg(args)).toEqual(args)
	})
})

describe("populateCliArgs / getParsedCliArgs", () => {
	it("parses real --model values", () => {
		populateCliArgs(["--model", "kimchi-dev/kimi-k2.7", "fix tests"])
		expect(getParsedCliArgs()).toEqual({ options: { model: "kimchi-dev/kimi-k2.7" }, positionals: ["fix tests"] })
	})

	it("reports no model option when --model is absent", () => {
		populateCliArgs(["--provider", "kimchi-dev", "fix tests"])
		expect(getParsedCliArgs()).toEqual({ options: { provider: "kimchi-dev" }, positionals: ["fix tests"] })
	})

	it("caches upstream project-trust overrides for trust-aware extensions", () => {
		populateCliArgs(["--approve"])
		expect(getParsedCliArgs()).toEqual({ options: { approve: true }, positionals: [] })

		populateCliArgs(["--no-approve"])
		expect(getParsedCliArgs()).toEqual({ options: { "no-approve": true }, positionals: [] })
	})

	it("reuses the cached parse across calls", () => {
		populateCliArgs(["--approve"])
		expect(getParsedCliArgs()).toEqual({ options: { approve: true }, positionals: [] })
		// Subsequent calls return the same cached result without re-parsing.
		expect(getParsedCliArgs()).toEqual({ options: { approve: true }, positionals: [] })
	})
})

describe("resolveBashProcessLimitSeconds", () => {
	it("parses --bash-process-limit as a positive integer", () => {
		populateCliArgs(["--bash-process-limit", "900"])
		expect(getParsedCliArgs().options["bash-process-limit"]).toBe("900")
		expect(resolveBashProcessLimitSeconds()).toBe(900)
	})

	it("returns undefined when the flag is absent", () => {
		populateCliArgs([])
		expect(resolveBashProcessLimitSeconds()).toBeUndefined()
	})

	for (const bad of ["abc", "0", "-5", "12.5", ""]) {
		it(`rejects ${JSON.stringify(bad)} at parse time with a clear error`, () => {
			expect(() => populateCliArgs(["--bash-process-limit", bad])).toThrow(/Invalid --bash-process-limit/)
		})
	}
})

describe("boolean =-form normalization", () => {
	it.each(["ferment-oneshot", "init-git", "memory", "help"])("rejects an invalid explicit value for --%s", (name) => {
		expect(() => parseCliArgs([`--${name}=junk`])).toThrow(
			`--${name} expects a boolean (=true or =false); got --${name}="junk"`,
		)
	})

	it("does not cache non-session booleans after validating them", () => {
		expect(parseCliArgs(["--init-git=true", "--ferment-oneshot=false"]).options).toEqual({})
	})

	it('enables --yolo=true (previously the string "true" — silently ignored)', () => {
		populateCliArgs(["--yolo=true", "fix tests"])
		expect(getParsedCliArgs().options.yolo).toBe(true)
	})

	it("disables on --yolo=false and keeps the bare flag true", () => {
		populateCliArgs(["--yolo=false", "fix tests"])
		expect(getParsedCliArgs().options.yolo).toBe(false)
		populateCliArgs(["--yolo", "fix tests"])
		expect(getParsedCliArgs().options.yolo).toBe(true)
	})

	it("normalizes every boolean flag's =-form", () => {
		populateCliArgs(["--yolo=true", "--plan=false"])
		expect(getParsedCliArgs().options.yolo).toBe(true)
		expect(getParsedCliArgs().options.plan).toBe(false)
	})

	it("rejects non-boolean =-values for boolean flags", () => {
		expect(() => populateCliArgs(["--yolo=1", "fix tests"])).toThrow(
			/--yolo expects a boolean \(=true or =false\); got --yolo="1"/,
		)
	})
})

describe("cacheable option coverage", () => {
	it("every CACHEABLE_OPTION_NAMES entry is declared in CLI_OPTIONS", () => {
		// parseCliArgs dereferences CLI_OPTIONS[key].type for each of these;
		// a name missing from the catalog is a startup crash, not a silent
		// miss, so the invariant is enforced here.
		const missing = CACHEABLE_OPTION_NAMES.filter((name) => !CLI_OPTIONS[name])
		expect(missing).toEqual([])
	})
})

describe("hidden catalog options", () => {
	it("parses hidden --debug-prompts as a boolean", () => {
		expect(parseCliArgs(["--debug-prompts"]).options["debug-prompts"]).toBe(true)
	})
})

const SRC_ROOT = join(import.meta.dirname, ".")

/** Files whose registerFlag calls are intentionally not literal. */
const NONLITERAL_REGISTRATION_ALLOWLIST: Record<string, string> = {
	"src/extensions/mcp/index.ts": "forwards flags from the MCP probe via target.registerFlag(name, flag)",
}

/** Shared flag-name constants that registerFlag calls may use instead of a literal. */
const FLAG_NAME_CONSTANTS: Record<string, string> = { DANGEROUS_BYPASS_FLAG }

function listSourceFiles(dir: string): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "__mocks__") continue
		const full = join(dir, entry.name)
		if (entry.isDirectory()) out.push(...listSourceFiles(full))
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full)
	}
	return out
}

function isRegisterFlagCallee(callee: ts.Expression): boolean {
	if (ts.isIdentifier(callee)) return callee.text === "registerFlag"
	if (ts.isPropertyAccessExpression(callee)) return callee.name.text === "registerFlag"
	if (ts.isElementAccessExpression(callee)) {
		const arg = callee.argumentExpression
		return ts.isStringLiteralLike(arg) && arg.text === "registerFlag"
	}
	return false
}

function resolveFlagName(node: ts.Expression): string | undefined {
	if (ts.isStringLiteralLike(node)) return node.text
	if (ts.isIdentifier(node) && Object.hasOwn(FLAG_NAME_CONSTANTS, node.text)) return FLAG_NAME_CONSTANTS[node.text]
	return undefined
}

function collectFileViolations(
	rel: string,
	file: string,
	text: string,
	allowlist: Record<string, string> = NONLITERAL_REGISTRATION_ALLOWLIST,
): string[] {
	const violations: string[] = []
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && isRegisterFlagCallee(node.expression)) visitRegistration(node)
		ts.forEachChild(node, visit)
	}
	const visitRegistration = (call: ts.CallExpression): void => {
		const [nameArg, defArg] = call.arguments
		const name = nameArg && resolveFlagName(nameArg)
		if (name === undefined) {
			if (rel in allowlist) return
			violations.push(`${rel}: nonliteral flag name ${nameArg?.getText(sf) ?? "<missing>"}`)
			return
		}
		const typeProp =
			defArg && ts.isObjectLiteralExpression(defArg)
				? defArg.properties.find(
						(p): p is ts.PropertyAssignment =>
							ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "type",
					)
				: undefined
		if (!typeProp || !ts.isStringLiteralLike(typeProp.initializer)) {
			violations.push(`${rel}: --${name} has no literal type`)
			return
		}
		const entry = CLI_OPTIONS[name]
		if (!entry) violations.push(`${rel}: --${name} missing from CLI_OPTIONS`)
		else if (entry.type !== typeProp.initializer.text) {
			violations.push(`${rel}: --${name} type ${typeProp.initializer.text} != CLI_OPTIONS ${entry.type}`)
		}
	}
	visit(sf)
	return violations
}

function collectRegisteredFlagCatalogViolations(): string[] {
	return listSourceFiles(SRC_ROOT).flatMap((file) =>
		collectFileViolations(`src/${relative(SRC_ROOT, file).split("\\").join("/")}`, file, readFileSync(file, "utf8")),
	)
}

describe("extension flag registration parity", () => {
	it("every literal registerFlag call has a CLI_OPTIONS entry with the same name and type", () => {
		const violations = collectRegisteredFlagCatalogViolations()
		expect(violations).toEqual([])
	})

	it.each(
		Object.keys(NONLITERAL_REGISTRATION_ALLOWLIST),
	)("allowlist entry %s still covers a nonliteral registerFlag call", (rel) => {
		const file = join(SRC_ROOT, rel.slice("src/".length))
		const violations = collectFileViolations(rel, file, readFileSync(file, "utf8"), {})
		expect(violations.some((v) => v.startsWith(`${rel}: nonliteral flag name`))).toBe(true)
	})

	it("still checks literal registrations in files allowlisted for nonliteral ones", () => {
		const rel = "src/extensions/mcp/index.ts"
		const text = 'pi.registerFlag("not-in-catalog", { type: "boolean" })\npi.registerFlag(name, flag)\n'
		expect(collectFileViolations(rel, rel, text)).toEqual([`${rel}: --not-in-catalog missing from CLI_OPTIONS`])
	})

	it.each([
		["a bare call", 'registerFlag("not-in-catalog", { type: "boolean" })'],
		["element access", 'pi["registerFlag"]("not-in-catalog", { type: "boolean" })'],
	])("checks registrations made through %s", (_label, text) => {
		const rel = "src/extensions/example.ts"
		expect(collectFileViolations(rel, rel, text)).toEqual([`${rel}: --not-in-catalog missing from CLI_OPTIONS`])
	})

	it("resolves known flag-name constants and checks them against the catalog", () => {
		const rel = "src/extensions/example.ts"
		const text =
			'pi.registerFlag(DANGEROUS_BYPASS_FLAG, { type: "string" })\npi.registerFlag(OTHER_FLAG, { type: "boolean" })\n'
		expect(collectFileViolations(rel, rel, text)).toEqual([
			`${rel}: --${DANGEROUS_BYPASS_FLAG} type string != CLI_OPTIONS boolean`,
			`${rel}: nonliteral flag name OTHER_FLAG`,
		])
	})
})

describe("normalizeBooleanFlagArgs", () => {
	const affected = [
		"plan",
		"pr-watch",
		"auto",
		"yolo",
		"dangerously-skip-permissions",
		"no-auto-update",
		"memory",
		"debug-prompts",
		"ferment-oneshot",
		"init-git",
	]

	it.each([
		[["--print", "--system-prompt", "--auto=false", "do work"]],
		[["--print", "--system-prompt", "--auto", "do work"]],
		[["--append-system-prompt", "--yolo=false", "do work"]],
		[["--name", "--plan", "do work"]],
		[["-t", "--auto=false", "do work"]],
		[["--session-id", "--auto=false", "do work"]],
	])("leaves a boolean that is another option's value unchanged: %j", (args) => {
		expect(normalizeBooleanFlagArgs(args)).toEqual(args)
	})

	it("keeps the system prompt and message when a boolean is the system prompt value", () => {
		const parsed = parsePiArgs(normalizeBooleanFlagArgs(["--print", "--system-prompt", "--auto=false", "do work"]))
		expect(parsed.systemPrompt).toBe("--auto=false")
		expect(parsed.messages).toEqual(["do work"])
	})

	it("rewrites the flag occurrence and keeps the value occurrence of the same boolean", () => {
		expect(normalizeBooleanFlagArgs(["--auto", "--system-prompt", "--auto", "x"])).toEqual([
			"--auto=true",
			"--system-prompt",
			"--auto",
			"x",
		])
	})

	it("still rewrites a boolean after a --mode that has no value", () => {
		expect(normalizeBooleanFlagArgs(["--mode", "--auto", "x"])).toEqual(["--mode", "--auto=true", "x"])
	})

	it("rewrites --auto before a positional prompt", () => {
		expect(normalizeBooleanFlagArgs(["--print", "--auto", "do work"])).toEqual(["--print", "--auto=true", "do work"])
	})

	it.each(affected)("rewrites affected boolean --%s before a positional prompt", (name) => {
		expect(normalizeBooleanFlagArgs(["--print", `--${name}`, "do work"])).toEqual([
			"--print",
			`--${name}=true`,
			"do work",
		])
	})

	it("rewrites --auto after a prompt-first invocation", () => {
		expect(normalizeBooleanFlagArgs(["--print", "do work", "--auto"])).toEqual(["--print", "do work", "--auto=true"])
	})

	it("keeps explicit --auto=true unchanged", () => {
		const args = ["--print", "--auto=true", "do work"]
		expect(normalizeBooleanFlagArgs(args)).toEqual(args)
	})

	// pi turns any value of a boolean extension flag into true, so =false must not reach it.
	it.each(affected)("drops explicit --%s=false so pi never reads it as on", (name) => {
		const normalized = normalizeBooleanFlagArgs(["--print", `--${name}=false`, "do work"])
		expect(normalized).toEqual(["--print", "do work"])
		const parsed = parsePiArgs(normalized)
		expect(parsed.unknownFlags.has(name)).toBe(false)
		expect(parsed.messages).toEqual(["do work"])
	})

	it("keeps --dangerously-skip-permissions=false from enabling the bypass on either side", () => {
		const normalized = normalizeBooleanFlagArgs(["--print", "--dangerously-skip-permissions=false", "do work"])
		expect(parsePiArgs(normalized).unknownFlags.has("dangerously-skip-permissions")).toBe(false)
		expect(parseCliArgs(normalized).options["dangerously-skip-permissions"]).toBeUndefined()
	})

	it("keeps =false for pi-known booleans and after the -- delimiter", () => {
		const args = ["--print", "--verbose=false", "--", "--auto=false"]
		expect(normalizeBooleanFlagArgs(args)).toEqual(args)
	})

	it("keeps the pi-known --verbose boolean exact", () => {
		expect(normalizeBooleanFlagArgs(["--print", "--verbose", "do work"])).toEqual(["--print", "--verbose", "do work"])
	})

	it.each(["continue", "no-session", "approve"])("keeps pi-known --%s unchanged", (name) => {
		const args = ["--print", `--${name}`]
		expect(normalizeBooleanFlagArgs(args)).toEqual(args)
	})

	it("keeps --deny-tool and its separate string value unchanged", () => {
		const args = ["--print", "--deny-tool", "write", "do work"]
		expect(normalizeBooleanFlagArgs(args)).toEqual(args)
	})

	it("stops rewriting at the -- delimiter", () => {
		const args = ["--print", "--", "--auto"]
		expect(normalizeBooleanFlagArgs(args)).toEqual(args)
	})

	it("rewrites several adjacent Kimchi-only booleans", () => {
		expect(normalizeBooleanFlagArgs(["--print", "--auto", "--yolo", "do work"])).toEqual([
			"--print",
			"--auto=true",
			"--yolo=true",
			"do work",
		])
	})

	it("keeps --auto unchanged when it is the --model value", () => {
		expect(normalizeBooleanFlagArgs(["--print", "--model", "--auto", "do work"])).toEqual([
			"--print",
			"--model",
			"--auto",
			"do work",
		])
	})

	it("leaves an invalid explicit boolean value for the Kimchi parser to reject", () => {
		const args = ["--print", "--auto=1", "do work"]
		expect(normalizeBooleanFlagArgs(args)).toEqual(args)
		expect(() => parseCliArgs(args)).toThrow(/--auto expects a boolean/)
	})

	it("rewrites a trailing --auto without inventing a positional value", () => {
		expect(normalizeBooleanFlagArgs(["--print", "--auto"])).toEqual(["--print", "--auto=true"])
	})

	it("leaves unknown third-party flags unchanged", () => {
		const args = ["--print", "--future-extension-flag", "do work"]
		expect(normalizeBooleanFlagArgs(args)).toEqual(args)
	})

	it("composes after stripping --enable-experimental-features", () => {
		const stripped = stripExperimentalFeaturesArg(["--print", "--enable-experimental-features", "--auto", "do work"])
		expect(normalizeBooleanFlagArgs(stripped)).toEqual(["--print", "--auto=true", "do work"])
	})

	it("does not mutate its input", () => {
		const args = ["--print", "--auto", "do work"]
		normalizeBooleanFlagArgs(args)
		expect(args).toEqual(["--print", "--auto", "do work"])
	})

	it("normalizes --auto so Kimchi's parser reads true", () => {
		expect(parseCliArgs(["--print", "--auto=true", "do work"]).options.auto).toBe(true)
	})

	it.each(affected)("preserves the prompt and unknown extension flag for rewritten --%s", (name) => {
		const normalized = normalizeBooleanFlagArgs(["--print", `--${name}`, "do work"])
		const parsed = parsePiArgs(normalized)
		expect(parsed.messages).toEqual(["do work"])
		expect(parsed.unknownFlags.has(name)).toBe(true)
	})

	const catalogBooleans = Object.keys(CLI_OPTIONS).filter((name) => CLI_OPTIONS[name].type === "boolean")
	it.each(catalogBooleans)("keeps the positional prompt for every catalog boolean --%s", (name) => {
		const normalized = normalizeBooleanFlagArgs(["--print", `--${name}`, "do work"])
		const parsed = parsePiArgs(normalized)
		expect(parsed.messages).toEqual(["do work"])
		if (parsePiArgs([`--${name}`]).unknownFlags.has(name)) {
			expect(normalized).toContain(`--${name}=true`)
			expect(parsed.unknownFlags.has(name)).toBe(true)
		} else {
			expect(normalized).toContain(`--${name}`)
		}
	})
})

describe("applyDebugPromptsOptOut", () => {
	const debugEnv = () => ({ KIMCHI_DEBUG_PROMPTS: "1", KIMCHI_DEBUG_SESSION: "abc" })

	it("clears both debug env vars on an explicit --debug-prompts=false", () => {
		const env = debugEnv()
		applyDebugPromptsOptOut(["--print", "--debug-prompts=false", "x"], env)
		expect(env).toEqual({})
	})

	it("uses the last value when the flag is repeated", () => {
		const env = debugEnv()
		applyDebugPromptsOptOut(["--debug-prompts", "--debug-prompts=false"], env)
		expect(env).toEqual({})
	})

	it.each([
		[["--debug-prompts"]],
		[["--debug-prompts=true"]],
		[["--debug-prompts=false", "--debug-prompts"]],
		[["--print", "x"]],
	])("keeps the debug env vars for %j", (args) => {
		const env = debugEnv()
		applyDebugPromptsOptOut(args, env)
		expect(env).toEqual(debugEnv())
	})
})

describe("hasInitGitArg", () => {
	it("matches --init-git and --init-git=true", () => {
		expect(hasInitGitArg(["--init-git"])).toBe(true)
		expect(hasInitGitArg(["--init-git=true"])).toBe(true)
	})

	it("does not match unrelated or disabled forms", () => {
		expect(hasInitGitArg(["-p", "hello"])).toBe(false)
		expect(hasInitGitArg(["--init-git=false"])).toBe(false)
		expect(hasInitGitArg(["init-git=true"])).toBe(false)
	})
})

describe("fermentLegacyFlagError", () => {
	let agentDir: string

	beforeEach(() => {
		// Isolate the resource settings path so a developer's real settings.json
		// can never flip the default-off legacy resource on.
		agentDir = mkdtempSync(join(tmpdir(), "cli-args-legacy-"))
		// stubEnv records the values from the isolated-home setup, so
		// unstubAllEnvs puts them back for any later test in this file.
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
		vi.stubEnv("KIMCHI_ENABLE_RESOURCES", undefined)
		resetOrgPolicyForTests()
	})

	afterEach(() => {
		resetOrgPolicyForTests()
		vi.unstubAllEnvs()
		rmSync(agentDir, { recursive: true, force: true })
	})

	it("reports the exact --ferment-oneshot error when legacy is off", () => {
		expect(fermentLegacyFlagError(["--ferment-oneshot"])).toBe(
			`--ferment-oneshot needs the legacy Ferment, which is off. Turn it on with: kimchi resources enable ${FERMENT_LEGACY_RESOURCE_ID}`,
		)
	})

	it("names --init-git in its own error when legacy is off", () => {
		expect(fermentLegacyFlagError(["--init-git"])).toBe(
			`--init-git needs the legacy Ferment, which is off. Turn it on with: kimchi resources enable ${FERMENT_LEGACY_RESOURCE_ID}`,
		)
	})

	it("catches the bare ferment-oneshot=true kwarg form (via hasFermentOneshotArg)", () => {
		expect(fermentLegacyFlagError(["ferment-oneshot=true"])).toContain("--ferment-oneshot needs the legacy Ferment")
	})

	it("returns undefined when no V1-only flag is present", () => {
		expect(fermentLegacyFlagError(["-p", "hello"])).toBeUndefined()
	})

	it.each([
		["--ferment-oneshot"],
		["--ferment-oneshot=true"],
		["--ferment-oneshot=false"],
		["--ferment-oneshot=0"],
		["--ferment-oneshot="],
		["--ferment-oneshot", "false"],
	])("catches %j with legacy off, since upstream would reject it as unknown", (...flagArgs) => {
		expect(fermentLegacyFlagError(["-p", ...flagArgs, "x"])).toBe(
			`--ferment-oneshot needs the legacy Ferment, which is off. Turn it on with: kimchi resources enable ${FERMENT_LEGACY_RESOURCE_ID}`,
		)
	})

	it.each([
		["--init-git"],
		["--init-git=true"],
		["--init-git=false"],
		["--init-git=0"],
		["--init-git="],
		["--init-git", "false"],
	])("catches %j with legacy off, since upstream would reject it as unknown", (...flagArgs) => {
		expect(fermentLegacyFlagError(["-p", ...flagArgs, "x"])).toBe(
			`--init-git needs the legacy Ferment, which is off. Turn it on with: kimchi resources enable ${FERMENT_LEGACY_RESOURCE_ID}`,
		)
	})

	it("catches =false values under an org FORCE_OFF too", async () => {
		await setOrgPolicyForTests({ resources: { [FERMENT_LEGACY_RESOURCE_ID]: "FORCE_OFF" } })
		expect(fermentLegacyFlagError(["--init-git=false"])).toContain("--init-git needs the legacy Ferment")
		expect(fermentLegacyFlagError(["--ferment-oneshot=false"])).toContain("--ferment-oneshot needs the legacy Ferment")
	})

	it("does not match flags that only share a prefix", () => {
		expect(fermentLegacyFlagError(["--init-gitx"])).toBeUndefined()
		expect(fermentLegacyFlagError(["--ferment-oneshotx=true"])).toBeUndefined()
		expect(fermentLegacyFlagError(["--foo-init-git=false"])).toBeUndefined()
	})

	it.each([
		["--ferment-oneshot"],
		["--ferment-oneshot=true"],
		["--ferment-oneshot=false"],
		["--init-git"],
		["--init-git=true"],
		["--init-git=false"],
		["--init-git", "false"],
	])("returns undefined for %j when legacy is on", (...flagArgs) => {
		process.env.KIMCHI_ENABLE_RESOURCES = FERMENT_LEGACY_RESOURCE_ID
		expect(fermentLegacyFlagError(["-p", ...flagArgs, "x"])).toBeUndefined()
	})

	it("returns undefined when legacy is enabled via env", () => {
		process.env.KIMCHI_ENABLE_RESOURCES = FERMENT_LEGACY_RESOURCE_ID
		expect(fermentLegacyFlagError(["--ferment-oneshot"])).toBeUndefined()
	})

	it("says the organization turned legacy off, without a resources enable hint, under FORCE_OFF", async () => {
		await setOrgPolicyForTests({ resources: { [FERMENT_LEGACY_RESOURCE_ID]: "FORCE_OFF" } })
		expect(fermentLegacyFlagError(["--ferment-oneshot"])).toBe(
			`--ferment-oneshot needs the legacy Ferment, which your organization turned off (${FERMENT_LEGACY_RESOURCE_ID} is locked off). Ask your organization admin to change the policy.`,
		)
		expect(fermentLegacyFlagError(["--init-git"])).toBe(
			`--init-git needs the legacy Ferment, which your organization turned off (${FERMENT_LEGACY_RESOURCE_ID} is locked off). Ask your organization admin to change the policy.`,
		)
		expect(fermentLegacyFlagError(["--ferment-oneshot"])).not.toContain("resources enable")
	})

	it("FORCE_OFF beats a local env enable and still reports the org lock", async () => {
		process.env.KIMCHI_ENABLE_RESOURCES = FERMENT_LEGACY_RESOURCE_ID
		await setOrgPolicyForTests({ resources: { [FERMENT_LEGACY_RESOURCE_ID]: "FORCE_OFF" } })
		expect(fermentLegacyFlagError(["--ferment-oneshot"])).toContain("your organization turned off")
	})

	it("keeps the ordinary enable hint under a soft org OFF the user can override", async () => {
		await setOrgPolicyForTests({ resources: { [FERMENT_LEGACY_RESOURCE_ID]: "OFF" } })
		expect(fermentLegacyFlagError(["--ferment-oneshot"])).toBe(
			`--ferment-oneshot needs the legacy Ferment, which is off. Turn it on with: kimchi resources enable ${FERMENT_LEGACY_RESOURCE_ID}`,
		)
	})

	it("returns undefined when no V1-only flag is present even under FORCE_OFF", async () => {
		await setOrgPolicyForTests({ resources: { [FERMENT_LEGACY_RESOURCE_ID]: "FORCE_OFF" } })
		expect(fermentLegacyFlagError(["-p", "hello"])).toBeUndefined()
	})

	it("names the organization and extensions.ferment when legacy inherits its FORCE_OFF", async () => {
		process.env.KIMCHI_ENABLE_RESOURCES = FERMENT_LEGACY_RESOURCE_ID
		await setOrgPolicyForTests({ resources: { "extensions.ferment": "FORCE_OFF" } })
		expect(fermentLegacyFlagError(["--ferment-oneshot"])).toBe(
			"--ferment-oneshot needs the legacy Ferment, which your organization turned off (extensions.ferment is locked off). Ask your organization admin to change the policy.",
		)
		expect(fermentLegacyFlagError(["--init-git"])).toBe(
			"--init-git needs the legacy Ferment, which your organization turned off (extensions.ferment is locked off). Ask your organization admin to change the policy.",
		)
	})

	it("returns undefined when legacy FORCE_ON overrides an extensions.ferment FORCE_OFF", async () => {
		await setOrgPolicyForTests({
			resources: { "extensions.ferment": "FORCE_OFF", [FERMENT_LEGACY_RESOURCE_ID]: "FORCE_ON" },
		})
		expect(fermentLegacyFlagError(["--ferment-oneshot"])).toBeUndefined()
	})

	it("returns undefined when org policy FORCE_ON locks legacy on", async () => {
		await setOrgPolicyForTests({ resources: { [FERMENT_LEGACY_RESOURCE_ID]: "FORCE_ON" } })
		expect(fermentLegacyFlagError(["--ferment-oneshot"])).toBeUndefined()
	})
})
