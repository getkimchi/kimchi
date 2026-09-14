// Compile the CLI into a standalone Bun binary, embedding the Photon WASM.
// Run with Bun (its build API supports asset-import plugins; Node cannot):
//   bun scripts/compile-binary.js src/entry.ts [--target bun-linux-arm64] --outfile dist/bin/kimchi [--external pkg]...
//
// photon_rs.js loads its WASM via `require('path').join(__dirname, 'photon_rs_bg.wasm')`
// — a build-machine path that doesn't exist at runtime. Instead of shipping the WASM
// next to the binary, the plugin below rewrites that one line to a Bun file import,
// which `--compile` embeds in the executable ($bunfs): the image code and its WASM
// always travel together, even if someone copies or replaces just the executable.

import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"

const DISK_PATH_LINE = "const path = require('path').join(__dirname, 'photon_rs_bg.wasm');"

const embedPhotonWasm = {
	name: "embed-photon-wasm",
	setup(build) {
		build.onLoad({ filter: /[/\\]@silvia-odwyer[/\\]photon-node[/\\]photon_rs\.js$/ }, async ({ path }) => {
			const source = await readFile(path, "utf8")
			if (!source.includes(DISK_PATH_LINE)) {
				throw new Error("Photon WASM loader changed; update the embed adapter in scripts/compile-binary.js")
			}
			return {
				contents: source.replace(
					DISK_PATH_LINE,
					'import photonWasmPath from "./photon_rs_bg.wasm" with { type: "file" };\nconst path = photonWasmPath;',
				),
				loader: "js",
			}
		})
	},
}

const { values, positionals } = parseArgs({
	args: process.argv.slice(2),
	allowPositionals: true,
	options: {
		target: { type: "string" },
		outfile: { type: "string" },
		external: { type: "string", multiple: true },
	},
})

if (positionals.length !== 1) throw new Error("expected exactly one entrypoint, e.g. src/entry.ts")
if (!values.outfile) throw new Error("--outfile is required")

const result = await Bun.build({
	entrypoints: positionals,
	target: "bun",
	external: values.external ?? [],
	plugins: [embedPhotonWasm],
	compile: {
		...(values.target ? { target: values.target } : {}),
		outfile: values.outfile,
		autoloadDotenv: false,
		autoloadBunfig: false,
		execArgv: ["--use-system-ca"],
	},
})

if (!result.success) {
	for (const log of result.logs) console.error(log)
	process.exit(1)
}
