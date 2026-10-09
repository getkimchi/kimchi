import { readdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { DEFAULT_SLUG, derivePlanTitle } from "../../shared/planning/plan-markdown.js"
import { isWorkId } from "../../shared/work-id.js"
import { mergePullRequestLinks, pullRequestLabel } from "../pull-request-status/links.js"
import { storedPullRequests } from "../pull-request-status/provider-records.js"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"
import type { WorkDetailsRequest } from "../work-attribution.js"
import { costDetailLines, knownSpend, ownRequests } from "./cost-details.js"
import { time } from "./costs.js"
import { object } from "./summary.js"

/** Besides the current work, the panel lists works whose summary changed recently. */
const RECENT_MS = 35 * 24 * 60 * 60_000
const MAX_WORKS = 30
/** Larger files are skipped rather than read; a plan is read only for its title. */
const MAX_SUMMARY_BYTES = 8 * 1024 * 1024
const MAX_PLAN_BYTES = 256 * 1024

type Entry = Record<string, unknown>
type Spend = ReturnType<typeof knownSpend>

/** One work's saved files; any of them can be missing or damaged. */
export interface SavedWork {
	workId: string
	/** Parsed `work.json`. */
	summary?: unknown
	/** Parsed `costs.json`. */
	costs?: unknown
	planTitle?: string
	/** `work.json` modification time, used when the summary has no timestamps. */
	modifiedAt?: number
}

export interface WorkRow {
	workId: string
	/** Plain text; the panel styles and shortens it. */
	label: string
	value: string
	description: string
	/** The text `/work` prints for this work. */
	details: string
}

export interface WorkBrowser {
	/** The current work first, then the others by last activity. */
	rows: WorkRow[]
	/** Spend across the listed works; connected works share requests, which count once. */
	spend: string
}

/** Reads only local files, so opening the panel never waits for the network. */
export async function readWorkBrowser(
	agentDir: string,
	current: WorkDetailsRequest,
	now = Date.now(),
): Promise<WorkBrowser> {
	const directory = join(agentDir, "work")
	// Recording any activity rewrites work.json, so its modification time bounds what is read.
	const modified = new Map<string, number>()
	await Promise.all(
		(await readdir(directory).catch(() => [])).filter(isWorkId).map(async (workId) => {
			const info = await stat(join(directory, workId, "work.json")).catch(() => undefined)
			if (info) modified.set(workId, info.mtimeMs)
		}),
	)

	const recent = [...modified]
		.filter(([workId, at]) => workId !== current.workId && at >= now - RECENT_MS)
		.sort(([, left], [, right]) => right - left)
		.slice(0, MAX_WORKS - 1)
		.map(([workId]) => workId)
	const works = await Promise.all(
		[current.workId, ...recent].map(async (workId): Promise<SavedWork> => {
			const folder = join(directory, workId)
			const [summary, costs] = await Promise.all([
				readJson(join(folder, "work.json")),
				readJson(join(folder, "costs.json")),
			])
			return {
				workId,
				summary,
				costs,
				planTitle: await readPlanTitle(folder, summary),
				modifiedAt: modified.get(workId),
			}
		}),
	)
	return buildWorkBrowser(agentDir, current, works)
}

/** Rows from saved summaries. Only the current work has live PR lookup lines; the rest use their saved links. */
export function buildWorkBrowser(agentDir: string, current: WorkDetailsRequest, works: SavedWork[]): WorkBrowser {
	const built = works
		.map((work) => workRow(agentDir, work, work.workId === current.workId ? current : undefined))
		.sort(
			(left, right) =>
				Number(right.current) - Number(left.current) ||
				(right.activity ?? 0) - (left.activity ?? 0) ||
				left.row.workId.localeCompare(right.row.workId),
		)
	// Connected works save the same requests in each costs.json; a saved price replaces a placeholder.
	const requests = new Map<unknown, Entry>()
	for (const { spent } of built)
		for (const request of spent ?? [])
			if (requests.get(request.requestId)?.priceStatus === undefined) requests.set(request.requestId, request)
	return {
		rows: built.map(({ row }) => row),
		spend: spendText(
			knownSpend([...requests.values()]),
			built.some(({ spent }) => !spent),
		),
	}
}

function workRow(agentDir: string, work: SavedWork, current?: WorkDetailsRequest) {
	const { workId } = work
	const folder = join(agentDir, "work", workId)
	const summary = object(work.summary) && work.summary.workId === workId ? work.summary : undefined
	const requests = entries(summary, "requests")
	const edits = entries(summary, "fileTransitions")
	const commits = entries(summary, "commits")
	const costs =
		object(work.costs) && Array.isArray(work.costs.pullRequests) && Array.isArray(work.costs.requests)
			? work.costs.requests.filter((row): row is Entry => object(row) && typeof row.requestId === "string")
			: undefined
	// Requests recorded after the last cost pass are not in costs.json yet; they count as unpriced.
	const saved = new Set(costs?.map((row) => row.requestId))
	const unpriced = requests.flatMap((row) =>
		typeof row.requestId === "string" && !saved.has(row.requestId) ? [{ requestId: row.requestId }] : [],
	)

	// A saved report also lists connected works' requests; the row shows this work's own spend.
	const spent = summary || costs ? [...(costs ? ownRequests(costs, workId) : []), ...unpriced] : undefined
	const links = mergePullRequestLinks(...commits.map((commit) => storedPullRequests(commit.pullRequests)))
	const times = [
		...requests.map((row) => time(row.startedAt)),
		...[...edits, ...entries(summary, "plans")].map((row) => time(row.recordedAt)),
	].filter((at) => at !== undefined)
	const activity = times.length ? Math.max(...times) : work.modifiedAt
	const { name, branch } = location(edits, commits, requests)
	const title = plain(work.planTitle ?? [name, branch].filter(Boolean).join(" · "))
	const pullRequests = current ? current.lines : links.map((pr) => `${pullRequestLabel(pr)}: ${pr.url}`)
	const costLines = costDetailLines(work.costs, join(folder, "costs.json"))
	const context = summary
		? [
				`Repository: ${name ? plain(name) : "unknown"}${branch ? ` · branch ${plain(branch)}` : ""}`,
				`Last activity: ${activity === undefined ? "unknown" : localTime(activity)} · ${requests.length} request${requests.length === 1 ? "" : "s"}`,
			]
		: [`Summary unavailable: ${join(folder, "work.json")}`]
	const row: WorkRow = {
		workId,
		label: `${current ? "●" : " "} ${workId.slice(0, 8)} ${title || (summary ? "untitled work" : "summary unavailable")}`,
		value: `${spendText(spent && knownSpend(spent))} · ${pullRequestState(links)}`,
		description: [`Work ID: ${workId}`, ...context, ...pullRequests, ...costLines].join("\n"),
		details: [`Work ID: ${workId}`, ...pullRequests, ...costLines].join("\n"),
	}
	return { row, current: current !== undefined, activity, spent }
}

/** Repository and branch of the latest native edit, else the repository of the latest commit or request. */
function location(edits: Entry[], commits: Entry[], requests: Entry[]): { name?: string; branch?: string } {
	const edit = newest(
		edits.filter((row) => typeof row.repository === "string"),
		"recordedAt",
	)

	const commit = newest(
		commits.filter((row) => typeof row.repository === "string"),
		"recordedAt",
	)

	const request = newest(requests, "startedAt")
	const scope = request && object(request.scope) ? request.scope : undefined
	const path = edit?.repository ?? commit?.repository ?? scope?.repository ?? request?.cwd
	const branch = newest(
		edits.filter((row) => typeof row.branch === "string"),
		"recordedAt",
	)?.branch
	return {
		name: typeof path === "string" ? repositoryName(path) : undefined,
		branch: typeof branch === "string" ? branch : undefined,
	}
}

/** `/src/app/.git` and `/srv/app.git` name `app`; a working directory names itself. */
function repositoryName(path: string): string {
	const name = basename(path)
	return name === ".git" ? basename(dirname(path)) : name.replace(/\.git$/, "")
}

/** Compact for the list, with exact amounts left to the description. Unpriced spend never shows as $0. */
function spendText(spend: Spend | undefined, partial = false): string {
	if (!spend) return "cost unknown"
	const complete = !partial && spend.priced === spend.total
	if (complete && !spend.total) return "no requests"
	if (!spend.nanos && !complete) return "cost unknown"
	return `${roundedUsd(spend.nanos)}${complete ? "" : " known so far"}`
}

function roundedUsd(nanos: bigint): string {
	if (!nanos) return "$0"
	const places = nanos < 1_000_000_000n ? 4 : 2
	const step = 10n ** BigInt(9 - places)
	const rounded = (nanos + step / 2n) / step
	if (!rounded) return "<$0.0001"
	const digits = rounded.toString().padStart(places + 1, "0")
	return `$${digits.slice(0, -places)}.${digits.slice(-places)}`
}

function pullRequestState(links: WorkPullRequest[]): string {
	if (links.length === 1) return pullRequestLabel(links[0])
	if (!links.length) return "no PR"
	return `${links.length} ${links.every((pr) => pr.provider === "gitlab") ? "MRs" : "PRs"}`
}

function localTime(at: number): string {
	const date = new Date(at)
	const pad = (value: number) => String(value).padStart(2, "0")
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Saved names come from model and Git output; keep them to one printable line. */
function plain(text: string): string {
	return text.replace(/\p{Cc}+/gu, " ").trim()
}

/** Object entries of one summary collection; a damaged collection reads as empty. */
function entries(summary: unknown, key: string): Entry[] {
	return object(summary) && Array.isArray(summary[key]) ? summary[key].filter(object) : []
}

/** The entry with the latest valid timestamp in `field`; later entries win ties. */
function newest(rows: Entry[], field: string): Entry | undefined {
	let latest: Entry | undefined
	for (const row of rows) if (!latest || (time(row[field]) ?? 0) >= (time(latest[field]) ?? 0)) latest = row
	return latest
}

/** Missing, special and oversized files read as undefined. */
async function readText(path: string, limit: number): Promise<string | undefined> {
	try {
		const info = await stat(path)
		return info.isFile() && info.size <= limit ? await readFile(path, "utf8") : undefined
	} catch {
		return undefined
	}
}

async function readJson(path: string): Promise<unknown> {
	const text = await readText(path, MAX_SUMMARY_BYTES)
	try {
		return text === undefined ? undefined : JSON.parse(text)
	} catch {
		return undefined
	}
}

/** The latest plan's title, read from its retained copy inside this work's folder. */
async function readPlanTitle(folder: string, summary: unknown): Promise<string | undefined> {
	const snapshot = newest(
		entries(summary, "plans").filter((row) => typeof row.snapshotPath === "string"),
		"recordedAt",
	)?.snapshotPath
	if (typeof snapshot !== "string") return undefined
	const text = await readText(join(folder, "plans", basename(snapshot)), MAX_PLAN_BYTES)
	const title = text === undefined ? undefined : derivePlanTitle(text)
	return title === DEFAULT_SLUG ? undefined : title
}
