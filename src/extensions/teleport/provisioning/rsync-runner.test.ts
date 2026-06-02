import type { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"
import {
	BASE_EXCLUDE_GLOBS,
	type RsyncStats,
	buildExcludeList,
	buildMkdirArgv,
	buildRsyncArgv,
	buildSshOption,
	handleLine,
	resolveGitIgnored,
} from "./rsync-runner.js"

// POSIX-ish word splitter that honors single quotes the way rsync's `-e`
// parser does. Sufficient for what buildSshOption produces — we control
// the inputs and never emit double-quoted or backslash-escaped strings.
function posixSplit(input: string): string[] {
	const out: string[] = []
	let cur = ""
	let inSingle = false
	let i = 0
	while (i < input.length) {
		const c = input[i]
		if (inSingle) {
			if (c === "'") {
				if (input.slice(i, i + 4) === "'\\''") {
					cur += "'"
					i += 4
					continue
				}
				inSingle = false
				i += 1
				continue
			}
			cur += c
			i += 1
			continue
		}
		if (c === "'") {
			inSingle = true
			i += 1
			continue
		}
		if (c === " " || c === "\t") {
			if (cur.length > 0) {
				out.push(cur)
				cur = ""
			}
			i += 1
			continue
		}
		cur += c
		i += 1
	}
	if (cur.length > 0) out.push(cur)
	return out
}

describe("buildSshOption", () => {
	it("composes the ssh command rsync's -e flag uses", () => {
		const got = buildSshOption({
			proxyCommand: "node /usr/local/lib/kimchi/teleport-proxy.js %h %p",
			knownHostsFile: "/tmp/known_hosts",
		})
		expect(got).toBe(
			"ssh -o ProxyCommand='node /usr/local/lib/kimchi/teleport-proxy.js %h %p' -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='/tmp/known_hosts' -o BatchMode=yes -o ServerAliveInterval=15",
		)
	})

	it("single-quote-wraps proxy paths and known_hosts paths containing spaces or special chars", () => {
		const got = buildSshOption({
			proxyCommand: "node /path with spaces/teleport-proxy.js %h %p",
			knownHostsFile: "/tmp/it's mine/known_hosts",
		})
		expect(got).toContain("ProxyCommand='node /path with spaces/teleport-proxy.js %h %p'")
		expect(got).toContain("UserKnownHostsFile='/tmp/it'\\''s mine/known_hosts'")
	})

	it("survives rsync's -e word splitter as one ProxyCommand token", () => {
		const got = buildSshOption({
			proxyCommand: "node /opt/kimchi/teleport-proxy.js %h %p",
			knownHostsFile: "/tmp/k/known_hosts",
		})
		const tokens = posixSplit(got)
		const proxyTokens = tokens.filter((t) => t.startsWith("ProxyCommand="))
		expect(proxyTokens).toEqual(["ProxyCommand=node /opt/kimchi/teleport-proxy.js %h %p"])
		const knownHostsTokens = tokens.filter((t) => t.startsWith("UserKnownHostsFile="))
		expect(knownHostsTokens).toEqual(["UserKnownHostsFile=/tmp/k/known_hosts"])
	})
})

describe("buildRsyncArgv", () => {
	it("produces the expected argv (snapshot)", () => {
		const argv = buildRsyncArgv({
			localPath: "/home/dev/project/",
			remotePath: "/home/sandbox/",
			remoteHost: "session-host.example.com",
			remoteUser: "sandbox",
			proxyCommand: "node /opt/kimchi/teleport-proxy.js %h %p",
			knownHostsFile: "/tmp/k/known_hosts",
			excludeFile: "/tmp/k/excludes",
		})
		expect(argv).toEqual([
			"-az",
			"--progress",
			"--stats",
			"--partial",
			"--exclude-from",
			"/tmp/k/excludes",
			"-e",
			"ssh -o ProxyCommand='node /opt/kimchi/teleport-proxy.js %h %p' -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='/tmp/k/known_hosts' -o BatchMode=yes -o ServerAliveInterval=15",
			"--delete",
			"/home/dev/project/",
			"sandbox@session-host.example.com:/home/sandbox/",
		])
	})

	it("includes --delete by default, omits it when deleteExtraneous is false", () => {
		const withDelete = buildRsyncArgv({
			localPath: "/a",
			remotePath: "/b",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			excludeFile: "/e",
		})
		expect(withDelete).toContain("--delete")
		const withoutDelete = buildRsyncArgv({
			localPath: "/a",
			remotePath: "/b",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			excludeFile: "/e",
			deleteExtraneous: false,
		})
		expect(withoutDelete).not.toContain("--delete")
	})

	it("passes local and remote paths verbatim — no trailing slash forcing", () => {
		const argv = buildRsyncArgv({
			localPath: "/file/no-slash",
			remotePath: "/file/also-no-slash",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			excludeFile: "/e",
		})
		// Caller decides directory-contents vs. directory-itself via trailing
		// slash; the builder must not mutate either path.
		expect(argv).toContain("/file/no-slash")
		expect(argv).toContain("u@h:/file/also-no-slash")
		expect(argv).not.toContain("/file/no-slash/")
		expect(argv).not.toContain("u@h:/file/also-no-slash/")
	})

	it("preserves trailing slashes that the caller supplied", () => {
		const argv = buildRsyncArgv({
			localPath: "/local/dir/",
			remotePath: "/remote/dir/",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			excludeFile: "/e",
		})
		expect(argv).toContain("/local/dir/")
		expect(argv).toContain("u@h:/remote/dir/")
	})

	it("swaps local/remote order when direction is 'down'", () => {
		const argv = buildRsyncArgv({
			localPath: "/local",
			remotePath: "/remote",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			excludeFile: "/e",
			direction: "down",
		})
		const remoteIdx = argv.indexOf("u@h:/remote")
		const localIdx = argv.indexOf("/local")
		expect(remoteIdx).toBeGreaterThan(-1)
		expect(localIdx).toBeGreaterThan(-1)
		expect(remoteIdx).toBeLessThan(localIdx)
	})

	it("appends --dry-run when dryRun is true", () => {
		const argv = buildRsyncArgv({
			localPath: "/a",
			remotePath: "/b",
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			excludeFile: "/e",
			dryRun: true,
		})
		expect(argv).toContain("--dry-run")
	})
})

describe("buildMkdirArgv", () => {
	it("builds an ssh argv that pre-creates a directory on the sandbox", () => {
		const argv = buildMkdirArgv({
			remoteHost: "h",
			remoteUser: "u",
			proxyCommand: "node /p %h %p",
			knownHostsFile: "/k",
			remoteDir: "/home/sandbox",
		})
		expect(argv).toEqual([
			"-o",
			"ProxyCommand=node /p %h %p",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			"UserKnownHostsFile=/k",
			"-o",
			"BatchMode=yes",
			"u@h",
			"mkdir -p /home/sandbox",
		])
	})
})

describe("buildExcludeList", () => {
	it("starts with BASE_EXCLUDE_GLOBS, then gitignored, then extras", () => {
		const got = buildExcludeList({
			gitignored: ["build/output", "log.txt"],
			extras: ["my-secret-dir/"],
		})
		expect(got.slice(0, BASE_EXCLUDE_GLOBS.length)).toEqual([...BASE_EXCLUDE_GLOBS])
		expect(got.slice(BASE_EXCLUDE_GLOBS.length)).toEqual(["build/output", "log.txt", "my-secret-dir/"])
	})

	it("is callable with no extras or gitignored", () => {
		expect(buildExcludeList({})).toEqual([...BASE_EXCLUDE_GLOBS])
	})
})

interface FakeChild extends EventEmitter {
	stdout: Readable
	stderr: Readable
	stdin: null
}

function makeFakeChild(opts: { stdout?: string; stderr?: string; exitCode: number; errorAfter?: boolean }): FakeChild {
	const child = new EventEmitter() as FakeChild
	child.stdout = Readable.from([opts.stdout ?? ""], { objectMode: false })
	child.stderr = Readable.from([opts.stderr ?? ""], { objectMode: false })
	child.stdin = null
	setImmediate(() => {
		if (opts.errorAfter) child.emit("error", new Error("ENOENT"))
		child.emit("close", opts.exitCode)
	})
	return child
}

describe("resolveGitIgnored", () => {
	it("returns the trimmed stdout lines on success", async () => {
		const fakeSpawn: typeof spawn = ((_cmd: string, _args?: readonly string[], _opts?: unknown) =>
			makeFakeChild({
				stdout: "build/output.txt\nlogs/access.log\n",
				exitCode: 0,
			})) as unknown as typeof spawn
		const result = await resolveGitIgnored("/dummy", undefined, fakeSpawn)
		expect(result).toEqual(["build/output.txt", "logs/access.log"])
	})

	it("returns [] when git exits non-zero (not a repo)", async () => {
		const fakeSpawn: typeof spawn = ((_cmd: string, _args?: readonly string[], _opts?: unknown) =>
			makeFakeChild({ stderr: "fatal: not a git repository", exitCode: 128 })) as unknown as typeof spawn
		const result = await resolveGitIgnored("/dummy", undefined, fakeSpawn)
		expect(result).toEqual([])
	})

	it("returns [] when git is missing (ENOENT)", async () => {
		const fakeSpawn: typeof spawn = ((_cmd: string, _args?: readonly string[], _opts?: unknown) =>
			makeFakeChild({ exitCode: 0, errorAfter: true })) as unknown as typeof spawn
		const result = await resolveGitIgnored("/dummy", undefined, fakeSpawn)
		expect(result).toEqual([])
	})
})

describe("handleLine", () => {
	function fresh(): RsyncStats {
		return { fileCount: 0, totalBytes: 0 }
	}

	it("parses GNU rsync 3.x: Number of regular files transferred", () => {
		const s = fresh()
		handleLine("Number of regular files transferred: 24", s)
		expect(s.fileCount).toBe(24)
	})

	it("parses GNU rsync 2.x / openrsync: Number of files transferred", () => {
		const s = fresh()
		handleLine("Number of files transferred: 2", s)
		expect(s.fileCount).toBe(2)
	})

	it("parses file count with commas (large transfer)", () => {
		const s = fresh()
		handleLine("Number of regular files transferred: 1,234", s)
		expect(s.fileCount).toBe(1234)
	})

	it("parses GNU rsync plain bytes", () => {
		const s = fresh()
		handleLine("Total transferred file size: 1234567 bytes", s)
		expect(s.totalBytes).toBe(1234567)
	})

	it("parses openrsync 'B' suffix", () => {
		const s = fresh()
		handleLine("Total transferred file size: 12 B", s)
		expect(s.totalBytes).toBe(12)
	})

	it("parses GNU rsync human-readable K suffix", () => {
		const s = fresh()
		handleLine("Total transferred file size: 121.67K bytes", s)
		expect(s.totalBytes).toBe(Math.round(121.67 * 1024))
	})

	it("parses GNU rsync human-readable M suffix", () => {
		const s = fresh()
		handleLine("Total transferred file size: 4.50M bytes", s)
		expect(s.totalBytes).toBe(Math.round(4.5 * 1024 * 1024))
	})

	it("parses GNU rsync human-readable G suffix", () => {
		const s = fresh()
		handleLine("Total transferred file size: 1.25G bytes", s)
		expect(s.totalBytes).toBe(Math.round(1.25 * 1024 ** 3))
	})

	it("parses bytes with commas", () => {
		const s = fresh()
		handleLine("Total transferred file size: 2,048,000 bytes", s)
		expect(s.totalBytes).toBe(2048000)
	})

	it("parses progress line and fires callback", () => {
		const s = fresh()
		let fired = false
		handleLine("      1,048,576  50%   1.00MB/s", s, (pct, bytes) => {
			expect(pct).toBe(50)
			expect(bytes).toBe(1048576)
			fired = true
		})
		expect(fired).toBe(true)
	})

	it("ignores unrecognised lines without mutating stats", () => {
		const s = fresh()
		handleLine("sending incremental file list", s)
		handleLine("", s)
		handleLine("file.txt", s)
		expect(s).toEqual({ fileCount: 0, totalBytes: 0 })
	})
})
