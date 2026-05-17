#!/usr/bin/env node
// Fake rsync used by rsync-transport.test.ts. Behaviour is controlled by env
// vars so a single binary covers progress/success/failure/hang paths.
//
//   FAKE_RSYNC_RECORD=<path>     Write the actual argv + AUTH_TOKEN to <path>.
//   FAKE_RSYNC_PROGRESS=<n>      Emit N progress lines (default 3).
//   FAKE_RSYNC_FILE_COUNT=<n>    Reported "regular files transferred" (default 3).
//   FAKE_RSYNC_TOTAL_BYTES=<n>   Reported "total transferred file size" (default 1234567).
//   FAKE_RSYNC_HANG=1            Sleep instead of exiting (for AbortSignal tests).
//   FAKE_RSYNC_EXIT=<code>       Exit code (default 0).
//   FAKE_RSYNC_STDERR=<msg>      Write <msg> to stderr before exiting.
//   FAKE_RSYNC_CARRIAGE_RETURN=1 Emit progress lines with \r terminators (matches
//                                 real rsync's in-place update style).

import { writeFileSync } from "node:fs"

const env = process.env

if (env.FAKE_RSYNC_RECORD) {
	const payload = {
		argv: process.argv.slice(2),
		authToken: env.AUTH_TOKEN ?? null,
		pathFirstEntry: (env.PATH ?? "").split(":")[0] ?? null,
	}
	writeFileSync(env.FAKE_RSYNC_RECORD, JSON.stringify(payload, null, 2))
}

if (env.FAKE_RSYNC_HANG === "1") {
	setInterval(() => {}, 1_000_000)
	const exit = () => process.exit(143)
	process.on("SIGTERM", exit)
	process.on("SIGINT", exit)
} else {
	const ticks = Number(env.FAKE_RSYNC_PROGRESS ?? 3)
	const eol = env.FAKE_RSYNC_CARRIAGE_RETURN === "1" ? "\r" : "\n"
	for (let i = 1; i <= ticks; i++) {
		const pct = Math.round((100 * i) / ticks)
		const bytes = 1048576 * i
		const line = `${formatBytes(bytes).padStart(15)} ${String(pct).padStart(3)}%   1.00MB/s    0:00:0${i}${eol}`
		process.stdout.write(line)
	}
	const fileCount = Number(env.FAKE_RSYNC_FILE_COUNT ?? 3)
	const totalBytes = Number(env.FAKE_RSYNC_TOTAL_BYTES ?? 1234567)
	process.stdout.write(
		[
			"",
			"Number of files: 5 (reg: 3, dir: 2)",
			"Number of created files: 5 (reg: 3, dir: 2)",
			`Number of regular files transferred: ${fileCount}`,
			`Total file size: ${totalBytes} bytes`,
			`Total transferred file size: ${totalBytes} bytes`,
			"Literal data: 0 bytes",
			"Matched data: 0 bytes",
			"File list size: 0",
			"File list generation time: 0.001 seconds",
			"File list transfer time: 0.000 seconds",
			`Total bytes sent: ${totalBytes + 222}`,
			"Total bytes received: 89",
			"",
			"",
		].join("\n"),
	)
	if (env.FAKE_RSYNC_STDERR) process.stderr.write(`${env.FAKE_RSYNC_STDERR}\n`)
	process.exit(Number(env.FAKE_RSYNC_EXIT ?? 0))
}

function formatBytes(n) {
	const s = String(n)
	const parts = []
	for (let i = s.length; i > 0; i -= 3) parts.unshift(s.slice(Math.max(0, i - 3), i))
	return parts.join(",")
}
