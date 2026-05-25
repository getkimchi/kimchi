declare module "terminal.js" {
	export interface TerminalOptions {
		columns?: number
		rows?: number
		attributes?: Record<string, unknown>
	}

	export interface LineData {
		str: string
		attr: Record<number, Record<string, unknown>>
	}

	export interface Cursor {
		x: number
		y: number
	}

	export interface ResizeOptions {
		columns: number
		rows: number
	}

	export class TermState {
		rows: number
		columns: number
		cursor: Cursor
		getBufferRowCount(): number
		getLine(n?: number): LineData
		resize(size: ResizeOptions): void
		write(chunk: string | Buffer, encoding?: string, callback?: () => void): void
	}

	class Terminal {
		state: TermState
		rows: number
		columns: number
		constructor(options?: TerminalOptions)
		write(chunk: string | Buffer, encoding?: string, callback?: () => void): void
		toString(format?: string): string
	}

	export default Terminal
}
