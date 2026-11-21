import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type Suite = "typecheck" | "unit" | "binary" | "smoke" | "tui" | "acp" | "mcp"

export const ALL_SUITES: Suite[] = ["typecheck", "unit", "binary", "smoke", "tui", "acp", "mcp"]

/** The full vitest suite can exhaust a laptop's memory, so local runs default to the cheap suites. */
export const LOCAL_DEFAULT_SUITES: Suite[] = ["typecheck", "unit"]

export const PI_PACKAGE = "@earendil-works/pi-coding-agent"

export interface RunConfig {
	/** Checkout whose package.json, patches/ and src/ are analysed. */
	repoRoot: string
	/** Where steps read and write their JSON outputs. */
	outDir: string
	baseline: string
	target: string | null
	now: Date
	suites: Suite[]
	publish: boolean
	stateFile?: string
	/** Target given explicitly (`--target`): settle rule bypassed, summary-only publish. */
	forced: boolean
}

export function readBaseline(repoRoot: string): string {
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
	const version = pkg.dependencies?.[PI_PACKAGE] ?? pkg.devDependencies?.[PI_PACKAGE]
	if (!version) throw new Error(`${PI_PACKAGE} is not pinned in ${repoRoot}/package.json`)
	return version
}

export function hasJson(cfg: RunConfig, name: string): boolean {
	return existsSync(join(cfg.outDir, `${name}.json`))
}

export function readJson<T>(cfg: RunConfig, name: string): T {
	const path = join(cfg.outDir, `${name}.json`)
	if (!existsSync(path)) throw new Error(`missing ${path}: run the step that produces it first`)
	return JSON.parse(readFileSync(path, "utf8")) as T
}

export function writeJson(cfg: RunConfig, name: string, value: unknown): void {
	mkdirSync(cfg.outDir, { recursive: true })
	writeFileSync(join(cfg.outDir, `${name}.json`), `${JSON.stringify(value, null, "\t")}\n`)
}
