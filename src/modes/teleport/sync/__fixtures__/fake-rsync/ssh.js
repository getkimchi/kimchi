#!/usr/bin/env node
// Fake ssh used by rsync-transport.test.ts. Just records the argv and AUTH_TOKEN
// then exits. Behaviour knobs:
//   FAKE_SSH_RECORD=<path>   Append a JSON line with the argv + AUTH_TOKEN.
//   FAKE_SSH_EXIT=<code>     Exit code (default 0).
//   FAKE_SSH_STDERR=<msg>    Write <msg> to stderr.

import { appendFileSync } from "node:fs"

const env = process.env

if (env.FAKE_SSH_RECORD) {
	const payload = {
		argv: process.argv.slice(2),
		authToken: env.AUTH_TOKEN ?? null,
	}
	appendFileSync(env.FAKE_SSH_RECORD, `${JSON.stringify(payload)}\n`)
}

if (env.FAKE_SSH_STDERR) process.stderr.write(`${env.FAKE_SSH_STDERR}\n`)
process.exit(Number(env.FAKE_SSH_EXIT ?? 0))
