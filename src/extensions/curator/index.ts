import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

// No-op: curator is invoked from the /improve skill which calls runCuratorPipeline.
// This export keeps the module valid for extension discovery.
export default async function curatorExtension(_pi: ExtensionAPI): Promise<void> {
	// Intentional no-op. The curator pipeline is called directly by the
	// /improve skill via import of runCuratorPipeline from "./curator.js".
}
