/**
 * Minimal ambient typings for Bun built-ins used by the terminal extension.
 * We declare only the surface we touch to avoid pulling in @types/bun,
 * which would shadow Node types in this mostly-Node codebase.
 */

declare module "bun" {
	export interface BunFile {
		arrayBuffer(): Promise<ArrayBuffer>
		bytes(): Promise<Uint8Array>
		text(): Promise<string>
	}

	export function file(path: string): BunFile
}

declare module "*.wasm" {
	const path: string
	export default path
}

declare const Bun:
	| {
			file(path: string): {
				arrayBuffer(): Promise<ArrayBuffer>
				bytes(): Promise<Uint8Array>
				text(): Promise<string>
			}
	  }
	| undefined
