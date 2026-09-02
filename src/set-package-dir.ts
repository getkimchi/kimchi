import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
process.env.PI_PACKAGE_DIR = resolve(__dirname, "..")
