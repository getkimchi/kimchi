#!/usr/bin/env python3
"""Extract text from benchmark analysis HTML files for Opus summarization.

Strips tags, collapses whitespace, keeps newlines from block elements.
Stdlib only. Replaces analysis.json as input to the Opus summarization step.

Usage:
    python3 extract_analysis_text.py <html_file>          # print to stdout
    python3 extract_analysis_text.py <html_file> -o out.txt
    python3 extract_analysis_text.py -d <directory>        # process all *.html
"""

from __future__ import annotations

import argparse
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

SKIP_TAGS = {"style", "script", "head"}

# Tags that should produce a newline after closing.
BLOCK_TAGS = {
    "p", "div", "section", "article", "header", "footer", "main",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "li", "tr", "blockquote", "pre", "hr", "br",
    "ul", "ol", "table", "thead", "tbody", "tfoot",
    "td", "th",
    "dt", "dd", "figure", "figcaption", "details", "summary",
}


class DumbHTMLToText(HTMLParser):
    """Strip HTML tags, keep newlines from block elements."""

    def __init__(self) -> None:
        super().__init__()
        self._out: list[str] = []
        self._skip_depth: int = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth > 0:
            return
        if tag in BLOCK_TAGS:
            self._out.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in SKIP_TAGS:
            self._skip_depth -= 1
            return
        if self._skip_depth > 0:
            return
        if tag in BLOCK_TAGS:
            self._out.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth > 0:
            return
        self._out.append(data)


def extract_text(html_content: str) -> str:
    """Convert HTML to plain text — tags stripped, whitespace collapsed."""
    parser = DumbHTMLToText()
    parser.feed(html_content)
    raw = "".join(parser._out)

    # Collapse each line's internal whitespace, strip trailing spaces.
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in raw.split("\n")]
    text = "\n".join(lines)

    # Collapse 3+ consecutive newlines to 2.
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract text from benchmark analysis HTML files."
    )
    parser.add_argument("path", type=Path, help="HTML file or directory of HTML files.")
    parser.add_argument("-o", "--output", type=Path, default=None,
                        help="Output file (stdout if omitted).")
    parser.add_argument("-d", "--directory", action="store_true",
                        help="Process all *.html files in the given directory.")
    args = parser.parse_args()

    if args.directory or args.path.is_dir():
        html_files = sorted(args.path.glob("*.html"))
        if not html_files:
            print(f"No HTML files found in {args.path}", file=sys.stderr)
            return 1

        for html_file in html_files:
            html = html_file.read_text(encoding="utf-8")
            text = extract_text(html)

            if args.output:
                out_path = args.output / f"{html_file.stem}.txt"
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text(text, encoding="utf-8")
                print(f"{html_file.name} -> {out_path.name} ({len(text)} chars)",
                      file=sys.stderr)
            else:
                print(f"{'=' * 80}", file=sys.stderr)
                print(f"FILE: {html_file.name}", file=sys.stderr)
                print(f"{'=' * 80}", file=sys.stderr)
                sys.stdout.write(text)
                print()

        return 0

    if not args.path.is_file():
        print(f"File not found: {args.path}", file=sys.stderr)
        return 1

    html = args.path.read_text(encoding="utf-8")
    text = extract_text(html)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
        print(f"Wrote {args.output} ({len(text)} chars)", file=sys.stderr)
    else:
        sys.stdout.write(text)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
