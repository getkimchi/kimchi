import type { ChildProcess } from "node:child_process"
import { spawn } from "node:child_process"

export interface PrInfo {
	number: number
	url: string
}

let currentPrInfo: PrInfo | undefined

export function getPrStatusLine(): PrInfo | undefined {
	return currentPrInfo
}

export function setPrStatusForTest(info: PrInfo | undefined): void {
	currentPrInfo = info
}

export interface PrStatusWatcherDeps {
	getCwd: () => string
	getBranch?: () => string | undefined
	spawnGh?: (cwd: string) => ChildProcess
}

const PR_REFRESH_INTERVAL_MS = 30_000

function defaultSpawnGh(cwd: string): ChildProcess {
	return spawn("gh", ["pr", "view", "--json", "number,url"], { cwd })
}

export function createPrStatusWatcher(deps: PrStatusWatcherDeps) {
	let timer: ReturnType<typeof setInterval> | undefined
	let onChangeCallback: (() => void) | undefined
	let inFlight = false

	function parseGhOutput(stdout: string): PrInfo | undefined {
		try {
			const parsed = JSON.parse(stdout) as unknown
			if (
				parsed &&
				typeof parsed === "object" &&
				"number" in parsed &&
				"url" in parsed &&
				typeof parsed.number === "number" &&
				typeof parsed.url === "string"
			) {
				return { number: parsed.number, url: parsed.url }
			}
		} catch {
			// ignore parse errors
		}
		return undefined
	}

	function runGh(cwd: string, callback: (info: PrInfo | undefined) => void): void {
		const child = (deps.spawnGh ?? defaultSpawnGh)(cwd)
		let stdout = ""
		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString()
		})
		child.on("close", (code: number | null) => {
			if (code !== 0) {
				callback(undefined)
				return
			}
			callback(parseGhOutput(stdout))
		})
		child.on("error", () => {
			callback(undefined)
		})
	}

	function setInfo(info: PrInfo | undefined): void {
		if (info === currentPrInfo) return
		currentPrInfo = info
		onChangeCallback?.()
	}

	function refresh(): void {
		if (inFlight) return
		inFlight = true
		runGh(deps.getCwd(), (info) => {
			inFlight = false
			setInfo(info)
		})
	}

	function start(onChange: () => void): void {
		stop()
		onChangeCallback = onChange
		refresh()
		timer = setInterval(() => refresh(), PR_REFRESH_INTERVAL_MS)
	}

	function stop(): void {
		if (timer) {
			clearInterval(timer)
			timer = undefined
		}
		onChangeCallback = undefined
		inFlight = false
		currentPrInfo = undefined
	}

	return { start, stop, refresh }
}
