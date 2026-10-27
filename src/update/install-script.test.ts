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
	let stage: string

	const script = (name: string, body: string) => {
		const path = join(commands, name)
		writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`)
		chmodSync(path, 0o700)
	}
	const read = (name: string) => readFileSync(join(root, name), "utf8")
	const run = (env: NodeJS.ProcessEnv = {}, fromStdin = false) => {
		const archive = join(root, "kimchi.tar.gz")
		execFileSync("tar", ["-czf", archive, "-C", stage, "."])
		return spawnSync("/bin/bash", fromStdin ? ["-s"] : [installer], {
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
				KIMCHI_REPO_OVERRIDE: "getkimchi/kimchi",
				KIMCHI_INSTALL_TEST_ROOT: root,
				KIMCHI_INSTALL_TEST_ARCHIVE: archive,
				...env,
			},
		})
	}

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
		for (const name of ["curl.log", "adapters.log"]) writeFileSync(join(root, name), "")
		stage = join(root, "release")
		mkdirSync(join(stage, "bin"), { recursive: true })
		mkdirSync(join(stage, "share", "kimchi", "adapters"), { recursive: true })
		writeFileSync(join(stage, "bin", "kimchi"), "#!/bin/sh\nprintf 'fixture Kimchi\\n'\n")
		writeFileSync(join(stage, "share", "kimchi", "theme.txt"), "fixture theme")
		// The bundled plugin installer; reading stdin would swallow a piped install.sh.
		writeFileSync(
			join(stage, "share", "kimchi", "adapters", "install.sh"),
			`#!/bin/sh
cat > /dev/null
printf '%s\\n' "$*" >> "$KIMCHI_INSTALL_TEST_ROOT/adapters.log"
printf '%s\\n' "$KIMCHI_BIN" > "$KIMCHI_INSTALL_TEST_ROOT/kimchi-bin"
[ "\${KIMCHI_INSTALL_TEST_ADAPTER_FAILURE:-}" != "$2" ]
`,
		)
		script(
			"curl",
			`printf '%s\\n' "$*" >> "$KIMCHI_INSTALL_TEST_ROOT/curl.log"
cat "$KIMCHI_INSTALL_TEST_ARCHIVE"`,
		)
		script("claude", "exit 0")
		script("codex", "exit 0")
	})

	afterEach(() => rmSync(root, { recursive: true, force: true }))

	it("adds the bundled plugins to each official client it finds", () => {
		const result = run()
		expect(result.status, result.stderr).toBe(0)
		expect(readFileSync(join(installBin, "kimchi"), "utf8")).toContain("fixture Kimchi")
		expect(readFileSync(join(root, "data", "kimchi", "theme.txt"), "utf8")).toBe("fixture theme")
		expect(read("adapters.log")).toBe("install claude\ninstall codex\n")
		// The plugins run on the Kimchi binary just installed.
		expect(read("kimchi-bin")).toBe(`${join(installBin, "kimchi")}\n`)
	})

	it("skips clients that are not installed", () => {
		rmSync(join(commands, "codex"))
		expect(run().status).toBe(0)
		expect(read("adapters.log")).toBe("install claude\n")
		rmSync(join(commands, "claude"))
		writeFileSync(join(root, "adapters.log"), "")
		expect(run().status).toBe(0)
		expect(read("adapters.log")).toBe("")
	})

	it("installs Kimchi alone from a release without the plugins", () => {
		rmSync(join(stage, "share", "kimchi", "adapters"), { recursive: true })
		const result = run()
		expect(result.status, result.stderr).toBe(0)
		expect(existsSync(join(installBin, "kimchi"))).toBe(true)
		expect(read("adapters.log")).toBe("")
	})

	it("keeps Kimchi installed and says how to retry when a plugin fails", () => {
		const result = run({ KIMCHI_INSTALL_TEST_ADAPTER_FAILURE: "claude" })
		expect(result.status).toBe(0)
		expect(existsSync(join(installBin, "kimchi"))).toBe(true)
		expect(result.stderr).toContain("work reporting for claude is not. Rerun this installer to retry.")
		expect(read("adapters.log")).toBe("install claude\ninstall codex\n")
	})

	it("supports the documented piped installer entry point", () => {
		const result = run({}, true)
		expect(result.status, result.stderr).toBe(0)
		expect(read("adapters.log")).toBe("install claude\ninstall codex\n")
		expect(result.stdout).toContain("Next:")
	})
})
