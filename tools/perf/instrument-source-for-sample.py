#!/usr/bin/env python3
"""Register the source-copied tracer in a disposable historical worktree."""
import argparse
import re
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
args = parser.parse_args()
cli = Path(args.root) / "src" / "cli.ts"
source = cli.read_text(encoding="utf-8")
import_line = 'import blockingInstructionsExtension from "./extensions/blocking-instructions.js"\n'
if import_line not in source:
    lines = source.splitlines(keepends=True)
    imports = [index for index, line in enumerate(lines) if line.startswith("import ")]
    if not imports:
        raise SystemExit("no import seam found")
    lines.insert(imports[-1] + 1, import_line)
    source = "".join(lines)
registration = re.compile(r"(?m)^[ \t]*blockingInstructionsExtension,\s*$")
if not registration.search(source):
    source, count = re.subn(
        r"(?m)^([ \t]*)interactiveErrorSurfaceExtension,\r?\n",
        lambda match: f"{match.group(1)}blockingInstructionsExtension,\n{match.group(0)}",
        source,
        count=1,
    )
    if count != 1:
        raise SystemExit("no single extension registration seam found")
cli.write_text(source, encoding="utf-8")
