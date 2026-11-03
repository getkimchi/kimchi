/**
 * Static formula checks for the XLSX writer. Runs before any XML is built.
 *
 * Catches, per formula: unbalanced parentheses/quotes, references to sheets
 * that don't exist, cells outside the referenced sheet's used range, unknown
 * function names, missing `_xlfn.` prefix on post-2007 functions, and spill
 * functions (warned about: older Excel shows them as @-implicit).
 */

import { parseRangeRef, splitSheetRef } from "./xlsx-refs.js"

export interface SheetShape {
	name: string
	lastRow: number
	lastColumn: number
}

export interface LintFinding {
	formula: string
	cell: string
	rule:
		| "unbalanced-syntax"
		| "unknown-sheet"
		| "out-of-range-ref"
		| "unknown-function"
		| "missing-xlfn"
		| "spill-function"
	message: string
}

/** Pre-2008 functions: the ones files may use unprefixed. */
const PRE_2008_FUNCTIONS = new Set(
	(
		"ABS ACCRINT ACCRINTM ADD ADDRESS AMORDEGRC AMORLINC AND AVERAGE AVERAGEA AVERAGEIF AVERAGEIFS " +
		"BESSELI BESSELJ BESSELK BESSELY BETADIST BETAINV BINOMDIST CEILING CELL CHIDIST CHIINV CHITEST CHOOSE " +
		"CLEAN CODE COLUMN COLUMNS COMBIN COMPLEX CONCATENATE CONFIDENCE CONVERT CORREL COS COSH COUNT COUNTA " +
		"COUNTBLANK COUNTIF COUNTIFS COUPDAYBS COUPDAYS COUPDAYSNC COUPNCD COUPNUM COUPPCD COVAR CRITBINOM DATE " +
		"DATEDIF DATEVALUE DAVERAGE DAY DAYS360 DB DCOUNT DCOUNTA DDB DEGREES DEVSQ DGET DISC DMAX DMIN DOLLAR " +
		"DOLLARDE DOLLARFR DPRODUCT DSTDEV DSTDEVP DSUM DURATION EDATE EFFECT EOMONTH ERF ERFC ERROR.TYPE EVEN " +
		"EXACT EXP EXPONDIST FACT FACTDOUBLE FALSE FDIST FIND FINDB FINV FISHER FISHERINV FIXED FLOOR FORECAST " +
		"FREQUENCY FTEST FV FVSCHEDULE GAMMADIST GAMMAINV GAMMALN GCD GEOMEAN GESTEP GROWTH HARMEAN HLOOKUP " +
		"HOUR HYPERLINK HYPGEOMDIST IF IFERROR INDEX INDIRECT INT INTERCEPT INTRATE IPMT IRR ISBLANK ISERR " +
		"ISERROR ISEVEN ISLOGICAL ISNA ISNONTEXT ISNUMBER ISODD ISPMT ISREF ISTEXT JIS KURT LARGE LCM LEFT " +
		"LEFTB LEN LENB LINEST LN LOG LOG10 LOGEST LOGINV LOGNORMDIST LOOKUP LOWER MATCH MAX MAXA MDETERM MDURATION " +
		"MEDIAN MID MIDB MIN MINA MINUTE MINVERSE MIRR MMULT MOD MODE MONTH MROUND MULTINOMIAL N NA NEGBINOMDIST " +
		"NETWORKDAYS NOMINAL NORMDIST NORMINV NORMSDIST NORMSINV NOT NOW NPER NPV OCT2BIN OCT2DEC OCT2HEX ODD " +
		"OFFSET OR PEARSON PERCENTILE PERCENTRANK PERMUT PHONETIC PI PMT POISSON POWER PPMT PRICE PRICEDISC " +
		"PRICEMAT PROB PRODUCT PROPER PV QUARTILE QUOTIENT RADIANS RAND RANDBETWEEN RANK RATE RECEIVED REPLACE " +
		"REPT RIGHT RIGHTB ROMAN ROUND ROUNDDOWN ROUNDUP ROW ROWS RSQ RTD SEARCH SEARCHB SECOND SERIESSUM SIGN " +
		"SIN SINH SKEW SLN SLOPE SMALL SORT SQRT SQRTPI STANDARDIZE STDEV STDEVA STDEVP STDEVPA STEYX SUBSTITUTE " +
		"SUBTOTAL SUM SUMIF SUMIFS SUMPRODUCT SUMSQ SUMX2MY2 SUMX2PY2 SUMXMY2 SYD T TAN TANH TBILLEQ TBILLPRICE " +
		"TBILLYIELD TDIST TEXT TIME TIMEVALUE TINV TODAY TRANSPOSE TREND TRIM TRIMMEAN TRUE TRUNC TTEST TYPE " +
		"UPPER VALUE VAR VARA VARP VARPA VDB VLOOKUP WEEKDAY WEIBULL WORKDAY XIRR XNPV YEAR YEARFRAC YIELD " +
		"YIELDDISC YIELDMAT ZTEST"
	).split(/\s+/),
)

/** Post-2007 functions that MUST carry the `_xlfn.` prefix in file format. */
const POST_2007_FUNCTIONS = new Set(
	(
		"AGGREGATE ARABIC BASE BETA.DIST BETA.INV BINOM.DIST BINOM.INV BITAND BITLSHIFT BITOR BITRSHIFT BITXOR " +
		"CEILING.MATH CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST COMBINA " +
		"CONFIDENCE.NORM CONFIDENCE.T COT COTH COVARIANCE.P COVARIANCE.S CSC CSCH DATEVALUE DAYS DECIMAL DEC2BIN " +
		"DEC2HEX DEC2OCT EOMONTH ERF.PRECISE ERFC.PRECISE EXPON.DIST F.DIST F.DIST.RT F.INV F.INV.RT F.TEST " +
		"FILTERXML FLOOR.MATH FLOOR.PRECISE FORMULATEXT GAMMA GAMMA.DIST GAMMA.INV GAMMALN.PRECISE GAUSS " +
		"HYPGEOM.DIST IFNA IFS ISFORMULA ISO.CEILING ISOWEEKNUM LOGNORM.DIST LOGNORM.INV MAXIFS MID MINIFS MODE.MULT " +
		"MODE.SNGL MUNIT NEGBINOM.DIST NETWORKDAYS.INTL NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV NUMBERVALUE PDURATION " +
		"PERCENTILE.EXC PERCENTILE.INC PERCENTRANK.EXC PERCENTRANK.INC PERMUTATIONA PHI POISSON.DIST P.STANDARDIZE " +
		"QUARTILE.EXC QUARTILE.INC RANK.AVG RANK.EQ RRI SEC SECH SHEET SHEETS SKEW.P STDEV.P STDEV.S SWITCH T.DIST " +
		"T.DIST.2T T.DIST.RT TEXTJOIN T.INV T.INV.2T T.TEST UNICHAR UNICODE VAR.P VAR.S WEEKDAY WEIBULL.DIST " +
		"WORKDAY.INTL XLOOKUP XMATCH Z.TEST FILTER SORT UNIQUE SEQUENCE LET LAMBDA RANDARRAY XLOOKUP CONCAT TEXTBEFORE " +
		"TEXTAFTER TEXTSPLIT VSTACK HSTACK TOCOL TOROW WRAPROWS WRAPCOLS TAKE DROP CHOOSEROWS CHOOSECOLS EXPAND"
	).split(/\s+/),
)

/** Newer functions whose results spill to a range — older Excel renders @. */
export const SPILL_FUNCTIONS = new Set(
	"XLOOKUP XMATCH FILTER SORT UNIQUE SEQUENCE RANDARRAY TEXTSPLIT VSTACK HSTACK TOCOL TOROW WRAPCOLS TAKE DROP CHOOSEROWS CHOOSECOLS EXPAND".split(
		/\s+/,
	),
)

interface Token {
	kind: "ref" | "func" | "other"
	text: string
}

/** Tokenize a formula (without the leading =): strings, calls, refs. */
function tokenize(formula: string): Token[] {
	const tokens: Token[] = []
	let i = 0
	const n = formula.length
	while (i < n) {
		const c = formula[i]
		if (c === '"') {
			const end = formula.indexOf('"', i + 1)
			if (end < 0) {
				tokens.push({ kind: "other", text: formula.slice(i) })
				i = n
			} else {
				tokens.push({ kind: "other", text: formula.slice(i, end + 1) })
				i = end + 1
			}
			continue
		}
		// Cell or range ref, possibly sheet-qualified.
		const refMatch = formula
			.slice(i)
			.match(/^('(?:[^']|'')+'|[A-Za-z0-9_.]+!)?\$?[A-Za-z]{1,3}\$?[0-9]+(:\$?[A-Za-z]{1,3}\$?[0-9]+)?/)
		if (refMatch) {
			const text = refMatch[0].endsWith("!") ? refMatch[0] : refMatch[0]
			// Reject partials like a function call "LOG10(" — the regex above is cell-shaped only.
			tokens.push({ kind: "ref", text })
			i += refMatch[0].length
			continue
		}
		const funcMatch = formula.slice(i).match(/^(?:_xlfn\.)?([A-Z][A-Z0-9._]*)(?=\()/)
		if (funcMatch) {
			tokens.push({ kind: "func", text: funcMatch[0] })
			i += funcMatch[0].length
			continue
		}
		tokens.push({ kind: "other", text: c })
		i++
	}
	return tokens
}

/** Balanced parentheses and quotes? */
function syntaxOk(formula: string): boolean {
	let depth = 0
	let inString = false
	for (const c of formula) {
		if (inString) {
			if (c === '"') inString = false
			continue
		}
		if (c === '"') inString = true
		else if (c === "(") depth++
		else if (c === ")") {
			depth--
			if (depth < 0) return false
		}
	}
	return depth === 0 && !inString
}

const MAX_ROWS = 1_048_576
const MAX_COLS = 16_384

/**
 * Lint one formula. `sheets` are the writer's sheet shapes (lastRow/lastColumn
 * of what will exist); `cell` is where the formula lands.
 */
export function lintFormula(
	formula: string,
	cell: string,
	sheets: SheetShape[],
	currentSheet?: SheetShape,
): LintFinding[] {
	const findings: LintFinding[] = []
	const body = formula.startsWith("=") ? formula.slice(1) : formula
	if (!syntaxOk(body)) {
		findings.push({ formula, cell, rule: "unbalanced-syntax", message: "unbalanced parentheses or quotes" })
		return findings
	}
	const byName = new Map(sheets.map((s) => [s.name.toLowerCase(), s]))
	for (const token of tokenize(body)) {
		if (token.kind === "func") {
			const name = token.text.replace(/^_xlfn\./, "").toUpperCase()
			if (!PRE_2008_FUNCTIONS.has(name) && !POST_2007_FUNCTIONS.has(name)) {
				findings.push({ formula, cell, rule: "unknown-function", message: `unknown function ${name}` })
				continue
			}
			if (POST_2007_FUNCTIONS.has(name) && !token.text.startsWith("_xlfn.")) {
				findings.push({
					formula,
					cell,
					rule: "missing-xlfn",
					message: `${name} needs the _xlfn. prefix in file format (the writer adds it)`,
				})
			}
			if (SPILL_FUNCTIONS.has(name)) {
				findings.push({
					formula,
					cell,
					rule: "spill-function",
					message: `${name} spills a range — older Excel versions show it as @-implicit and single-valued`,
				})
			}
			continue
		}
		if (token.kind === "ref") {
			const { sheet, ref } = splitSheetRef(token.text)
			const range = parseRangeRef(ref)
			if (!range) continue
			if (sheet !== undefined) {
				const target = byName.get(sheet.toLowerCase())
				if (!target) {
					findings.push({
						formula,
						cell,
						rule: "unknown-sheet",
						message: `references sheet ${JSON.stringify(sheet)} which does not exist (${sheets.map((s) => s.name).join(", ")})`,
					})
					continue
				}
				if (range.end.row > Math.max(target.lastRow, 1) || range.end.column > Math.max(target.lastColumn, 1)) {
					findings.push({
						formula,
						cell,
						rule: "out-of-range-ref",
						message: `${token.text} reaches past sheet "${target.name}"'s data (${target.lastRow} rows, ${target.lastColumn} columns)`,
					})
				}
			} else {
				if (range.end.row > MAX_ROWS || range.end.column > MAX_COLS) {
					findings.push({ formula, cell, rule: "out-of-range-ref", message: `${token.text} is beyond the sheet grid` })
				} else if (
					currentSheet &&
					(range.end.row > Math.max(currentSheet.lastRow, 1) || range.end.column > Math.max(currentSheet.lastColumn, 1))
				) {
					findings.push({
						formula,
						cell,
						rule: "out-of-range-ref",
						message: `${token.text} reaches past the sheet's data (${currentSheet.lastRow} rows, ${currentSheet.lastColumn} columns)`,
					})
				}
			}
		}
	}
	return findings
}

/** Post-process: add `_xlfn.` where a post-2007 function lacks it. Skips
 *  string literals so a formula like TEXTJOIN("SUM(",…) isn't mangled. */
export function applyXlfnPrefixes(formula: string): string {
	return formula.replace(/"[^"]*"|(?<![\w.]|_xlfn\.)([A-Z][A-Z0-9._]*)(?=\()/g, (m, name: string | undefined) => {
		if (!name) return m // quoted literal
		return POST_2007_FUNCTIONS.has(name) ? `_xlfn.${name}` : m
	})
}
