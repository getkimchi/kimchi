import { execFileSync, spawnSync } from "node:child_process"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const installer = fileURLToPath(new URL("../../scripts/install.sh", import.meta.url))

describe.skipIf(process.platform === "win32")("shared Kimchi shell installer", () => {
	let root: string
	let commands: string
	let installBin: string
	let archive: string

	const script = (name: string, body: string) => {
		const path = join(commands, name)
		writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`)
		chmodSync(path, 0o700)
	}
	const read = (name: string) => readFileSync(join(root, name), "utf8")
	const run = (args: string[] = [], env: NodeJS.ProcessEnv = {}, fromStdin = false) =>
		spawnSync("/bin/bash", fromStdin ? ["-s", "--", ...args] : [installer, ...args], {
			encoding: "utf8",
			input: fromStdin ? readFileSync(installer, "utf8") : undefined,
			timeout: 10_000,
			env: {
				...process.env,
				PATH: `${commands}:${installBin}`,
				SHELL: "/bin/sh",
				KIMCHI_INSTALL_DIR: installBin,
				XDG_DATA_HOME: join(root, "data"),
				KIMCHI_VERSION: "latest",
				KIMCHI_ADAPTERS_VERSION: "",
				KIMCHI_REPO_OVERRIDE: "getkimchi/kimchi",
				KIMCHI_INSTALL_TEST_ROOT: root,
				KIMCHI_INSTALL_TEST_ARCHIVE: archive,
				...env,
			},
		})

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "kimchi installer "))
		commands = join(root, "commands")
		installBin = join(root, "installed")
		mkdirSync(commands)
		for (const name of [
			"uname",
			"tr",
			"tar",
			"gzip",
			"mktemp",
			"rm",
			"mkdir",
			"mv",
			"chmod",
			"cat",
			"grep",
			"cp",
			"bash",
		]) {
			const actual = execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim()
			symlinkSync(actual, join(commands, name))
		}
		for (const name of ["gh.log", "curl.log", "adapters.log"]) writeFileSync(join(root, name), "")
		const stage = join(root, "release")
		mkdirSync(join(stage, "bin"), { recursive: true })
		mkdirSync(join(stage, "share", "kimchi"), { recursive: true })
		writeFileSync(join(stage, "bin", "kimchi"), "#!/bin/sh\nprintf 'fixture Kimchi\\n'\n")
		writeFileSync(join(stage, "share", "kimchi", "theme.txt"), "fixture theme")
		archive = join(root, "kimchi.tar.gz")
		execFileSync("tar", ["-czf", archive, "-C", stage, "."])
		writeFileSync(
			join(root, "adapter-bootstrap.sh"),
			`#!/bin/sh
printf '%s\\n' "$*" >> "$KIMCHI_INSTALL_TEST_ROOT/adapters.log"
[ "\${KIMCHI_INSTALL_TEST_ADAPTER_FAILURE:-0}" = 0 ]
`,
		)
		script(
			"curl",
			`printf '%s\\n' "$*" >> "$KIMCHI_INSTALL_TEST_ROOT/curl.log"
cat "$KIMCHI_INSTALL_TEST_ARCHIVE"`,
		)
		script(
			"gh",
			`printf '%s\\n' "$*" >> "$KIMCHI_INSTALL_TEST_ROOT/gh.log"
[ "\${KIMCHI_INSTALL_TEST_GH_FAILURE:-0}" = 0 ] || exit 42
if [ "$2" = list ]; then printf '%s\\n' v0.1.0-rc.5; exit 0; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = --dir ]; then destination=$2; shift 2; else shift; fi
done
cp "$KIMCHI_INSTALL_TEST_ROOT/adapter-bootstrap.sh" "$destination/install.sh"`,
		)
		script("claude", "exit 0")
		script("codex", "exit 0")
	})

	afterEach(() => rmSync(root, { recursive: true, force: true }))

	it("keeps the default Kimchi-only installation independent of private adapter access", () => {
		for (const name of ["gh", "claude", "codex"]) rmSync(join(commands, name))
		const result = run()
		expect(result.status, result.stderr).toBe(0)
		expect(readFileSync(join(installBin, "kimchi"), "utf8")).toContain("fixture Kimchi")
		expect(readFileSync(join(root, "data", "kimchi", "theme.txt"), "utf8")).toBe("fixture theme")
		expect(read("gh.log")).toBe("")
		expect(read("adapters.log")).toBe("")
	})

	it.each(["claude", "codex", "both"])("installs Kimchi and delegates only the selected %s adapters", (selection) => {
		const result = run(["--adapters", selection])
		expect(result.status, result.stderr).toBe(0)
		expect(existsSync(join(installBin, "kimchi"))).toBe(true)
		expect(read("gh.log")).toContain("getkimchi/kimchi-adapters")
		expect(read("adapters.log")).toBe(`install ${selection} v0.1.0-rc.5\n`)
	})

	it("pins Kimchi and adapter versions independently", () => {
		const result = run(["--adapters", "codex"], { KIMCHI_VERSION: "v1.2.3", KIMCHI_ADAPTERS_VERSION: "v0.2.0-rc.1" })
		expect(result.status, result.stderr).toBe(0)
		expect(read("curl.log")).toContain("/releases/download/v1.2.3/kimchi_")
		expect(read("adapters.log")).toBe("install codex v0.2.0-rc.1\n")
		expect(read("gh.log")).not.toContain("release list")
	})

	it("supports the documented piped installer entry point", () => {
		const result = run(["--adapters", "both"], {}, true)
		expect(result.status, result.stderr).toBe(0)
		expect(read("adapters.log")).toBe("install both v0.1.0-rc.5\n")
		expect(result.stdout).toContain("Next:")
	})

	it.each([
		["--adapters", "other"],
		["--adapters"],
		["--unknown"],
	])("rejects invalid arguments %j before downloads", (...args) => {
		const result = run(args)
		expect(result.status).not.toBe(0)
		expect(read("curl.log")).toBe("")
		expect(read("gh.log")).toBe("")
	})

	it("checks only the selected official client", () => {
		rmSync(join(commands, "codex"))
		expect(run(["--adapters", "both"]).status).not.toBe(0)
		expect(read("curl.log")).toBe("")
		expect(run(["--adapters", "claude"]).status).toBe(0)
	})

	it("requires GitHub CLI only when adapters are requested", () => {
		rmSync(join(commands, "gh"))
		const result = run(["--adapters", "claude"])
		expect(result.status).not.toBe(0)
		expect(result.stderr).toContain("GitHub CLI")
		expect(read("curl.log")).toBe("")
	})

	it.each(["", "v0.1.0-rc.5"])("fails private adapter access before installing Kimchi (%s)", (version) => {
		const result = run(["--adapters", "both"], {
			KIMCHI_INSTALL_TEST_GH_FAILURE: "1",
			KIMCHI_ADAPTERS_VERSION: version,
		})
		expect(result.status).not.toBe(0)
		expect(existsSync(join(installBin, "kimchi"))).toBe(false)
		expect(read("curl.log")).toBe("")
	})

	it("rejects an invalid adapter version before private downloads", () => {
		const result = run(["--adapters", "both"], { KIMCHI_ADAPTERS_VERSION: "--invalid" })
		expect(result.status).not.toBe(0)
		expect(read("gh.log")).toBe("")
		expect(read("curl.log")).toBe("")
	})

	it("reports failure if native provisioning fails after Kimchi installs", () => {
		const result = run(["--adapters", "both"], { KIMCHI_INSTALL_TEST_ADAPTER_FAILURE: "1" })
		expect(result.status).not.toBe(0)
		expect(existsSync(join(installBin, "kimchi"))).toBe(true)
		expect(result.stderr).toContain("adapter installation failed")
	})

	it("shows the shared entry point without installing on help", () => {
		const result = run(["--help"])
		expect(result.status).toBe(0)
		expect(result.stdout).toContain("--adapters")
		expect(read("curl.log")).toBe("")
	})
})
