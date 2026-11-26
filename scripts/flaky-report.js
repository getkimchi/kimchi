import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const DEFAULT_EVENTS = "master,merge_queue,nightly"
const PAGE_SIZE = 100
const MAX_PAGES = 200

export function classify(records, options = {}) {
	const grouped = new Map()
	let skipped = 0
	for (const record of records) {
		try {
			validateRecord(record)
		} catch {
			skipped += 1
			continue
		}
		const current = grouped.get(record.testKey) ?? []
		current.push(record)
		grouped.set(record.testKey, current)
	}

	const output = { flaky: [], failing: [], skipped }
	for (const [testKey, testResults] of grouped) {
		const commits = new Map()
		for (const result of testResults) {
			if (!result.commit) continue
			const commitResults = commits.get(result.commit) ?? []
			commitResults.push(result)
			commits.set(result.commit, commitResults)
		}

		const commitOutcomes = [...commits.values()].map((commitResults) => ({
			passed: commitResults.some((result) => result.status === "passed"),
			failed: commitResults.some((result) => result.status === "failed"),
		}))
		const mixedCommitCount = commitOutcomes.filter((outcome) => outcome.passed && outcome.failed).length
		const failureCommitCount = commitOutcomes.filter((outcome) => outcome.failed && !outcome.passed).length
		const flakyFlagCount = testResults.filter((result) => result.flaky).length
		const failures = testResults.filter((result) => result.status === "failed").length
		const classification =
			mixedCommitCount > 0 || flakyFlagCount > 0 ? "flaky" : failureCommitCount > 0 ? "failing" : "stable"
		if (classification === "stable") continue

		const createdTimes = testResults.map((result) => result.createdAt)
		const messages = new Map()
		for (const result of testResults) {
			if (result.status !== "failed" || !result.message) continue
			const message = truncate(result.message, 200)
			messages.set(message, (messages.get(message) ?? 0) + 1)
		}
		const links = uniqueLinks(testResults, options)
		output[classification].push({
			testKey: String(testKey),
			fullName: testResults[0].fullName,
			totalRuns: testResults.length,
			failures,
			flakyFlagCount,
			mixedCommitCount,
			failureCommitCount,
			failureRate: failures / testResults.length,
			firstSeen: Math.min(...createdTimes),
			lastSeen: Math.max(...createdTimes),
			failureMessages: [...messages.entries()]
				.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
				.slice(0, 3)
				.map(([message]) => message),
			links,
		})
	}

	const byFlakyRank = (left, right) =>
		right.mixedCommitCount - left.mixedCommitCount ||
		right.flakyFlagCount - left.flakyFlagCount ||
		right.failureRate - left.failureRate ||
		left.fullName.localeCompare(right.fullName)
	output.flaky.sort(byFlakyRank)
	output.failing.sort((left, right) => left.fullName.localeCompare(right.fullName))
	return output
}

export async function runReport({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
	const config = readConfig(env)
	const events = parseEvents(env.FLAKY_EVENTS)
	const windowHours = positiveNumber(env.FLAKY_WINDOW_HOURS ?? "48", "FLAKY_WINDOW_HOURS")
	const client = await createClient(config, fetchImpl)
	const since = now() - windowHours * 60 * 60 * 1000
	const searchedLaunches = await getAllPages(client, "/api/rs/launch/__search", {
		projectId: config.projectId,
		rql: `createdDate >= ${since}`,
		sort: "createdDate,desc",
	})
	const listedLaunches = await getAllPages(client, "/api/rs/launch", {
		projectId: config.projectId,
		sort: "createdDate,desc",
	})
	const launchesById = new Map()
	for (const launch of [...searchedLaunches, ...listedLaunches]) launchesById.set(launch.id, launch)
	const launches = [...launchesById.values()].filter(
		(launch) => Number(launch.createdDate) >= since && events.has(tagMap(launch).get("event")),
	)

	const records = []
	for (const launch of launches) {
		const tags = tagMap(launch)
		const summaries = await getAllPages(client, "/api/rs/testresult", { launchId: launch.id, sort: "id,asc" })
		for (const summary of summaries) {
			const id = summary.id ?? summary.resultId
			if (id === undefined || id === null) throw new Error(`Test result without id in launch ${launch.id}`)
			const detail = await client.get(`/api/rs/testresult/${id}`)
			records.push(normalizeResult({ launch, tags, summary, detail, resultId: id }))
		}
	}

	const report = classify(records, {
		endpoint: config.endpoint,
		projectId: config.projectId,
		githubServerUrl: env.GITHUB_SERVER_URL,
		githubRepository: env.GITHUB_REPOSITORY,
	})
	const document = {
		generatedAt: new Date(now()).toISOString(),
		windowHours,
		events: [...events],
		launchCount: launches.length,
		resultCount: records.length,
		...report,
	}
	mkdirSync(config.outDir, { recursive: true })
	writeFileSync(join(config.outDir, "flaky-report.json"), `${JSON.stringify(publicReport(document), null, 2)}\n`)
	const markdown = renderMarkdown(publicReport(document))
	writeFileSync(join(config.outDir, "flaky-report.md"), markdown)
	if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown)
	return document
}

export async function runProbe({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
	const config = readConfig(env)
	const windowHours = positiveNumber(env.FLAKY_WINDOW_HOURS ?? "48", "FLAKY_WINDOW_HOURS")
	const events = parseEvents(env.FLAKY_EVENTS)
	const client = await createClient(config, fetchImpl)
	const probeDir = join(config.outDir, "probe")
	mkdirSync(probeDir, { recursive: true })
	const writeProbe = (name, data, kind) =>
		writeFileSync(join(probeDir, name), `${JSON.stringify(apiShape(data, kind), null, 2)}\n`)

	const launchPage = await client.get("/api/rs/launch/__search", {
		projectId: config.projectId,
		rql: `createdDate >= ${now() - windowHours * 60 * 60 * 1000}`,
		page: 0,
		size: 3,
		sort: "createdDate,desc",
	})
	writeProbe("launches.json", launchPage, "launch")
	const launchListPage = await client.get("/api/rs/launch", {
		projectId: config.projectId,
		page: 0,
		size: 3,
		sort: "createdDate,desc",
	})
	writeProbe("launch-list.json", launchListPage, "launch")
	const launches = pageItems(launchListPage).filter(
		(launch) =>
			Number(launch.createdDate) >= now() - windowHours * 60 * 60 * 1000 && events.has(tagMap(launch).get("event")),
	)
	const launch = launches.at(-1) ?? pageItems(launchPage).at(-1)
	if (!launch) return { launches: 0, results: 0 }

	const resultsPage = await client.get("/api/rs/testresult", { launchId: launch.id, page: 0, size: 3, sort: "id,desc" })
	writeProbe("test-results.json", resultsPage)
	let resultId
	let detail
	for (const summary of pageItems(resultsPage)) {
		const candidateId = summary.id ?? summary.resultId
		if (candidateId === undefined || candidateId === null) continue
		resultId = candidateId
		detail = await client.get(`/api/rs/testresult/${resultId}`)
		if (hasFlakyFlag(summary, detail)) break
	}
	if (resultId === undefined || !detail) return { launches: 1, results: 0 }
	writeProbe("test-result-detail.json", detail)
	const attachments = await client.get("/api/rs/testresult/attachment", { testResultId: resultId, page: 0, size: 10 })
	writeProbe("test-result-attachments.json", attachments)
	try {
		const history = await client.get(`/api/rs/testresult/${resultId}/history`, { page: 0, size: 10 })
		writeProbe("test-result-history.json", history)
	} catch (error) {
		if (!String(error.message).includes("HTTP 404")) throw error
		writeProbe("test-result-history.json", { error: "Not found", status: 404 })
	}
	return { launches: 1, results: pageItems(resultsPage).length }
}

export function apiShape(value, documentKind = "result", path = []) {
	if (Array.isArray(value)) {
		return {
			$type: "array",
			length: value.length,
			items: value.map((item, index) => apiShape(item, documentKind, [...path, index])),
		}
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, apiShape(item, documentKind, [...path, key])]),
		)
	}
	if (value === null) return "<null>"
	if (allowedPrimitive(path, documentKind)) return value
	if (typeof value === "string") return `<string len=${value.length}>`
	return `<${typeof value}>`
}

function allowedPrimitive(path, documentKind) {
	const key = path.at(-1)
	const parent = path.at(-2)
	if (["status", "flaky", "known"].includes(key)) return true
	if (["createdDate", "totalElements", "totalPages", "number", "size", "numberOfElements"].includes(key)) return true
	if (parent === "status" && (key === "name" || key === "value")) return true
	if (path.some((part) => part === "tags" || part === "tag" || part === "launchTags")) {
		return key === "name" || typeof key === "number"
	}
	return documentKind === "launch" && key === "name" && /^(content|results)\.\d+\.name$/.test(path.join("."))
}

function publicReport(report) {
	const publicRow = (row) => ({
		fullName: row.fullName,
		totalRuns: row.totalRuns,
		failures: row.failures,
		flakyFlagCount: row.flakyFlagCount,
		mixedCommitCount: row.mixedCommitCount,
		failureCommitCount: row.failureCommitCount,
		failureRate: row.failureRate,
		failureMessages: row.failureMessages,
		links: row.links,
	})
	return {
		windowHours: report.windowHours,
		events: report.events,
		launchCount: report.launchCount,
		resultCount: report.resultCount,
		skipped: report.skipped,
		flaky: report.flaky.map(publicRow),
		failing: report.failing.map(publicRow),
	}
}

function readConfig(env) {
	const endpoint = env.ALLURE_ENDPOINT?.replace(/\/$/, "")
	const token = env.ALLURE_TOKEN
	const projectId = env.ALLURE_PROJECT_ID
	const outDir = env.FLAKY_OUT_DIR
	if (!endpoint) throw new Error("ALLURE_ENDPOINT is required")
	if (!token) throw new Error("ALLURE_TOKEN is required")
	if (!projectId) throw new Error("ALLURE_PROJECT_ID is required")
	if (!outDir) throw new Error("FLAKY_OUT_DIR is required")
	return { endpoint, token, projectId, outDir }
}

function positiveNumber(value, name) {
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`)
	return parsed
}

function parseEvents(value) {
	const events = (value || DEFAULT_EVENTS)
		.split(",")
		.map((event) => event.trim())
		.filter(Boolean)
	if (events.length === 0) throw new Error("FLAKY_EVENTS must contain at least one event")
	return new Set(events)
}

async function createClient(config, fetchImpl) {
	const oauthPath = "/api/uaa/oauth/token"
	const body = new URLSearchParams({ grant_type: "apitoken", scope: "openid", token: config.token })
	const response = await fetchImpl(new URL(oauthPath, `${config.endpoint}/`), {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body,
	})
	console.log(`POST ${oauthPath} ${response.status}`)
	if (!response.ok) throw new Error(`OAuth token exchange failed: HTTP ${response.status}`)
	const oauth = await response.json()
	if (!oauth.access_token) throw new Error("OAuth token exchange response did not contain access_token")
	const bearer = oauth.access_token

	return {
		async get(path, params = {}) {
			const url = new URL(path, `${config.endpoint}/`)
			for (const [key, value] of Object.entries(params)) {
				if (value !== undefined) url.searchParams.set(key, String(value))
			}
			const page = url.searchParams.has("page") ? undefined : "0"
			if (page) url.searchParams.set("page", page)
			if (!url.searchParams.has("size")) url.searchParams.set("size", String(PAGE_SIZE))
			let result
			for (let attempt = 0; attempt < 3; attempt += 1) {
				result = await fetchImpl(url, {
					headers: { Accept: "application/json", Authorization: `Bearer ${bearer}` },
				})
				console.log(`GET ${url.pathname} ${result.status}`)
				if (result.ok || ![502, 503, 504].includes(result.status) || attempt === 2) break
				await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
			}
			if (!result.ok) throw new Error(`GET ${url.pathname} failed: HTTP ${result.status}: ${await result.text()}`)
			return result.json()
		},
	}
}

export async function getAllPages(client, path, params) {
	const items = []
	let page = 0
	while (page < MAX_PAGES) {
		const data = await client.get(path, { ...params, page, size: PAGE_SIZE })
		const current = pageItems(data)
		if (current.length === 0) return items
		items.push(...current)
		const hasTotalPages = Number.isFinite(data.totalPages)
		if (data.last === true || (hasTotalPages && page + 1 >= data.totalPages)) return items
		if (data.last === false || hasTotalPages) {
			page += 1
			continue
		}
		if (current.length < PAGE_SIZE) return items
		page += 1
	}
	throw new Error(`Pagination limit of ${MAX_PAGES} pages exceeded for ${path}`)
}

function pageItems(data) {
	if (Array.isArray(data)) return data
	return data?.content ?? data?.results ?? []
}

function tagMap(launch) {
	const tags = new Map()
	const add = (tag) => {
		if (typeof tag === "string") {
			for (const item of tag.split(",")) {
				const separator = item.indexOf("=")
				if (separator > 0) tags.set(item.slice(0, separator), item.slice(separator + 1))
			}
			return
		}
		if (Array.isArray(tag)) {
			for (const item of tag) add(item)
			return
		}
		if (!tag || typeof tag !== "object") return
		if (tag.name !== undefined) return add(String(tag.name))
		if (tag.key !== undefined && tag.value !== undefined) return add(`${tag.key}=${tag.value}`)
		for (const [key, value] of Object.entries(tag)) {
			if (typeof value === "string" || typeof value === "number") add(`${key}=${value}`)
		}
	}
	add(launch.tags ?? launch.tag ?? launch.launchTags)
	return tags
}

function normalizeResult({ launch, tags, summary, detail, resultId }) {
	const statusDetails = detail.statusDetails ?? detail.execution?.statusDetails ?? summary.statusDetails ?? {}
	const testCase = detail.testCase ?? summary.testCase ?? {}
	const fullName = detail.fullName ?? summary.fullName ?? testCase.fullName ?? detail.name ?? summary.name
	const testKey =
		detail.testCaseId ?? summary.testCaseId ?? testCase.id ?? detail.historyId ?? summary.historyId ?? fullName
	return {
		testKey: String(testKey),
		fullName: String(fullName),
		status: normalizeStatus(detail.status ?? summary.status),
		flaky: hasFlakyFlag(summary, detail),
		commit: tags.get("commit") ?? null,
		runId: tags.get("run_id") ?? null,
		runAttempt: tags.get("run_attempt") ?? null,
		launchId: launch.id,
		resultId,
		message: statusDetails.message ?? detail.message ?? summary.message ?? null,
		createdAt: detail.createdDate ?? summary.createdDate ?? launch.createdDate,
	}
}

function hasFlakyFlag(summary, detail = {}) {
	const statusDetails = detail.statusDetails ?? detail.execution?.statusDetails ?? summary.statusDetails ?? {}
	if (
		[statusDetails.flaky, detail.flaky, detail.execution?.flaky, summary.flaky].some(
			(value) => value === true || value === "true",
		)
	) {
		return true
	}
	const message = statusDetails.message ?? detail.message ?? summary.message
	return typeof message === "string" && /^passed after \d+ failed attempts?$/.test(message.trim())
}

function normalizeStatus(value) {
	const status = String(value?.name ?? value?.value ?? value ?? "").toLowerCase()
	if (status === "passed") return "passed"
	if (status === "failed" || status === "broken") return "failed"
	return status
}

function validateRecord(record) {
	if (!record || typeof record !== "object") throw new TypeError("Malformed test result record")
	if (typeof record.testKey !== "string" || !record.testKey)
		throw new TypeError("Malformed record: testKey is required")
	if (typeof record.fullName !== "string" || !record.fullName)
		throw new TypeError("Malformed record: fullName is required")
	if (record.status !== "passed" && record.status !== "failed")
		throw new TypeError("Malformed record: status must be passed or failed")
	if (typeof record.flaky !== "boolean") throw new TypeError("Malformed record: flaky must be boolean")
	if (typeof record.commit !== "string" || !record.commit) throw new TypeError("Malformed record: commit is required")
	if (!Number.isFinite(record.createdAt)) throw new TypeError("Malformed record: createdAt must be a timestamp")
	if (
		record.launchId === undefined ||
		record.launchId === null ||
		record.resultId === undefined ||
		record.resultId === null
	) {
		throw new TypeError("Malformed record: launchId and resultId are required")
	}
}

function uniqueLinks(results, options) {
	const links = []
	const seen = new Set()
	const add = (type, title, url) => {
		if (!url || seen.has(url)) return
		seen.add(url)
		links.push({ type, title, url })
	}
	for (const result of results) {
		if (options.endpoint && options.projectId) {
			add(
				"testops",
				`Result ${result.resultId}`,
				`${options.endpoint}/project/${options.projectId}/test-results/${result.resultId}`,
			)
		}
		if (options.githubServerUrl && options.githubRepository && result.runId && result.runAttempt) {
			add(
				"github",
				`Run ${result.runId} attempt ${result.runAttempt}`,
				`${options.githubServerUrl.replace(/\/$/, "")}/${options.githubRepository}/actions/runs/${result.runId}/attempts/${result.runAttempt}`,
			)
		}
	}
	return links
}

function renderMarkdown(report) {
	const lines = [
		"# Flaky Test Triage",
		"",
		`Window: ${report.windowHours}h · Events: ${report.events.join(", ")} · Launches scanned: ${report.launchCount} · Results scanned: ${report.resultCount} · Records skipped: ${report.skipped}`,
		"",
		"## Flaky",
		"",
	]
	appendTable(lines, report.flaky)
	lines.push("", "## Persistently failing", "")
	appendTable(lines, report.failing)
	lines.push("")
	return lines.join("\n")
}

function appendTable(lines, rows) {
	if (rows.length === 0) {
		lines.push("None detected.")
		return
	}
	lines.push("| Test | Runs | Failures | Flaky flags | Mixed commits | Failure rate | Failure messages | Links |")
	lines.push("| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |")
	for (const row of rows) {
		lines.push(
			`| ${cell(row.fullName)} | ${row.totalRuns} | ${row.failures} | ${row.flakyFlagCount} | ${row.mixedCommitCount} | ${(row.failureRate * 100).toFixed(1)}% | ${cell(row.failureMessages.join("<br>") || "—")} | ${row.links.map((link) => `[${cell(link.title)}](${link.url})`).join("<br>") || "—"} |`,
		)
	}
}

function cell(value) {
	return String(value).replaceAll("|", "\\|").replaceAll("\n", " ")
}

function truncate(value, length) {
	const text = String(value)
	return text.length <= length ? text : `${text.slice(0, length - 1)}…`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const probe = process.argv.includes("--probe")
	const operation = probe ? runProbe : runReport
	operation()
		.then((result) => {
			if (probe) console.log(`Probe complete: ${result.launches} launch(es), ${result.results} result item(s) captured`)
		})
		.catch((error) => {
			let message = error instanceof Error ? error.message : String(error)
			for (const value of [process.env.ALLURE_TOKEN]) {
				if (value) message = message.replaceAll(value, "[redacted]")
			}
			console.error(`flaky-report: ${message}`)
			process.exitCode = 1
		})
}
