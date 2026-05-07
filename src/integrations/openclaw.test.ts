import type { execFileSync as ExecFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildOpenClawModelsCatalog, buildOpenClawProviderBlock, writeOpenClawEnv } from "./openclaw.js"
import { byId } from "./registry.js"

type ExecFile = typeof ExecFileSync

describe("buildOpenClawProviderBlock", () => {
	it("uses the kimchi base URL and ${KIMCHI_API_KEY} placeholder", () => {
		const block = buildOpenClawProviderBlock() as { baseUrl: string; apiKey: string; api: string; models: unknown[] }
		expect(block.baseUrl).toBe("https://llm.kimchi.dev/openai/v1")
		expect(block.apiKey).toBe("${KIMCHI_API_KEY}")
		expect(block.api).toBe("openai-completions")
		expect(block.models.length).toBe(6)
	})

	it("includes per-model id/name/contextWindow/maxTokens", () => {
		const block = buildOpenClawProviderBlock() as {
			models: Array<{ id: string; name: string; contextWindow: number; maxTokens: number }>
		}
		const main = block.models.find((m) => m.id === "kimchi/kimi-k2.6")
		expect(main).toBeDefined()
		expect(main?.name).toBe("Kimi K2.6")
		expect(main?.contextWindow).toBe(262_144)
		expect(main?.maxTokens).toBe(32_768)
	})
})

describe("buildOpenClawModelsCatalog", () => {
	it("maps each model id to its display alias", () => {
		const catalog = buildOpenClawModelsCatalog()
		expect(catalog["kimchi/kimi-k2.6"]).toEqual({ alias: "Kimi K2.6" })
		expect(catalog["kimchi/kimi-k2.5"]).toEqual({ alias: "Kimi K2.5" })
		expect(catalog["kimchi/nemotron-3-super-fp4"]).toEqual({ alias: "Nemotron 3 Super FP4" })
		expect(catalog["kimchi/minimax-m2.7"]).toEqual({ alias: "MiniMax M2.7" })
	})
})

describe("writeOpenClawEnv", () => {
	let tmp: string
	let prevHome: string | undefined

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "kimchi-openclaw-test-"))
		prevHome = process.env.HOME
		process.env.HOME = tmp
	})

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
		if (prevHome === undefined) delete process.env.HOME
		else process.env.HOME = prevHome
		rmSync(tmp, { recursive: true, force: true })
	})

	it("creates the .env file with the API key when none exists", () => {
		mkdirSync(join(tmp, ".openclaw"), { recursive: true })
		writeOpenClawEnv("test-key-123")
		expect(readFileSync(join(tmp, ".openclaw", ".env"), "utf-8")).toBe("KIMCHI_API_KEY=test-key-123\n")
	})

	it("creates the parent directory if missing", () => {
		writeOpenClawEnv("fresh")
		expect(readFileSync(join(tmp, ".openclaw", ".env"), "utf-8")).toBe("KIMCHI_API_KEY=fresh\n")
	})

	it("replaces an existing KIMCHI_API_KEY line in place, preserving other entries", () => {
		mkdirSync(join(tmp, ".openclaw"), { recursive: true })
		writeFileSync(join(tmp, ".openclaw", ".env"), "OTHER_VAR=keep-me\nKIMCHI_API_KEY=old-key\nALSO=keep\n", "utf-8")
		writeOpenClawEnv("new-key")
		expect(readFileSync(join(tmp, ".openclaw", ".env"), "utf-8")).toBe(
			"OTHER_VAR=keep-me\nKIMCHI_API_KEY=new-key\nALSO=keep\n",
		)
	})

	it("appends KIMCHI_API_KEY when the file exists but doesn't have one yet", () => {
		mkdirSync(join(tmp, ".openclaw"), { recursive: true })
		writeFileSync(join(tmp, ".openclaw", ".env"), "OTHER=foo\n", "utf-8")
		writeOpenClawEnv("appended")
		expect(readFileSync(join(tmp, ".openclaw", ".env"), "utf-8")).toBe("OTHER=foo\nKIMCHI_API_KEY=appended\n")
	})
})

describe("openclaw tool registration", () => {
	it("registers itself with install metadata for the wizard", () => {
		const tool = byId("openclaw")
		expect(tool).toBeDefined()
		expect(tool?.installUrl).toBe("https://openclaw.ai/install.sh")
		expect(tool?.installArgs).toEqual(["--no-prompt", "--no-onboard"])
	})
	it("write() rejects an empty API key", async () => {
		const tool = byId("openclaw")
		await expect(tool?.write("global", "")).rejects.toThrow(/API key/)
	})
})
