# lodraw_edit.py — runs INSIDE soffice as a user macro (LibreOffice's bundled
# python is killed standalone on macOS by code signing). Parameterized via
# environment variables set by the pdf CLI:
#   LO_MODE   dump | apply
#   LO_PDF    input pdf (filesystem path)
#   LO_OUT    dump: json output path | apply: exported pdf path
#   LO_STATUS json status path (ok/pages/applied or ok/error)
#   LO_MAP    apply only: json edits [{"page":1,"shape":4,"text":"..."}]
#
# Pitfalls encoded (each verified the hard way):
# - PDFs need FilterName="draw_pdf_import" on load — without it loading hangs.
# - Exports need FilterName="draw_pdf_Export" via storeToURL, never `store`
#   (the original must stay byte-identical for safe re-runs).
# - Edited shapes need TextWordWrap=False or substituted text silently wraps
#   and overlaps the next line.
# - pyuno here wants method forms: getCount()/getPosition()/getSize().
# - DrawPages.getCount() after close(False) throws — capture first.

import json
import os
import traceback

import uno
import unohelper
from com.sun.star.beans import PropertyValue


def _props(**kw):
    out = []
    for k, v in kw.items():
        p = PropertyValue()
        p.Name = k
        p.Value = v
        out.append(p)
    return tuple(out)


def _status(payload):
    with open(os.environ["LO_STATUS"], "w") as f:
        json.dump(payload, f)


def _fail():
    try:
        _status({"ok": False, "error": traceback.format_exc()})
    except Exception:
        pass


def main():
    mode = os.environ.get("LO_MODE", "dump")
    try:
        if mode == "apply":
            _apply()
        else:
            _dump()
    except Exception:
        _fail()


def _open(desktop, src):
    return desktop.loadComponentFromURL(
        unohelper.systemPathToFileUrl(src),
        "_blank",
        0,
        _props(Hidden=True, ReadOnly=False, FilterName="draw_pdf_import"),
    )


def _dump():
    src = os.environ["LO_PDF"]
    out = os.environ["LO_OUT"]
    ctx = uno.getComponentContext()
    desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
    doc = _open(desktop, src)
    if doc is None:
        _status({"ok": False, "error": "load failed (is the PDF import filter installed?)"})
        return
    shapes_out = []
    pages = doc.DrawPages
    for pi in range(pages.getCount()):
        page = pages.getByIndex(pi)
        for si in range(page.getCount()):
            sh = page.getByIndex(si)
            if not sh.supportsService("com.sun.star.drawing.Text"):
                continue
            text = sh.getString()
            if not text.strip():
                continue
            pos = sh.getPosition()
            size = sh.getSize()
            shapes_out.append(
                {
                    "page": pi + 1,
                    "shape": si,
                    "xywh": [pos.X, pos.Y, size.Width, size.Height],
                    "text": text,
                }
            )
    pageCount = pages.getCount()
    doc.close(False)
    with open(out, "w") as f:
        json.dump({"pages": pageCount, "shapes": shapes_out}, f, ensure_ascii=False)
    _status({"ok": True, "pages": pageCount, "shapes": len(shapes_out)})


def _apply():
    src = os.environ["LO_PDF"]
    out = os.environ["LO_OUT"]
    with open(os.environ["LO_MAP"]) as f:
        edits = json.load(f)
    ctx = uno.getComponentContext()
    desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
    doc = _open(desktop, src)
    if doc is None:
        _status({"ok": False, "error": "load failed (is the PDF import filter installed?)"})
        return
    pages = doc.DrawPages
    applied = 0
    errors = []
    for e in edits:
        try:
            page = pages.getByIndex(int(e["page"]) - 1)
            sh = page.getByIndex(int(e["shape"]))
            sh.setPropertyValue("TextWordWrap", False)
            sh.setString(str(e["text"]))
            applied += 1
        except Exception as exc:
            errors.append("page %s shape %s: %s" % (e.get("page"), e.get("shape"), exc))
    if applied == 0:
        doc.close(False)
        _status({"ok": False, "error": "no edits applied; " + "; ".join(errors[:3])})
        return
    doc.storeToURL(unohelper.systemPathToFileUrl(out), _props(FilterName="draw_pdf_Export"))
    pageCount = pages.getCount()
    doc.close(False)
    _status({"ok": True, "pages": pageCount, "applied": applied, "errors": errors})


# script provider entrypoint alias
g_exportedScripts = (main,)
