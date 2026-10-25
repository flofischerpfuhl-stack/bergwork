#!/usr/bin/env python3
"""Recompute per-file facts and tags for the berg:work PDF corpus.

Reads manifest.json (next to this script by default), inspects every file under
the corpus root with local tools and rewrites the derived fields of each entry:
sha256, bytes, pages, pdfVersion, producer, facts, tags (genre tags and any tag
listed in `KEEP_TAGS` are preserved), password/ownerPassword (only filled in when
they were null and a candidate password works) and expect (only an automatically
derived {"open": "fail", "note": "auto: ..."} is added/removed; manually written expect values are kept).

Tools: qpdf, pdfinfo, pdffonts, pdftotext, pdfimages (poppler) and pikepdf.
Every tool call is time-boxed; the pikepdf analysis runs in a child process so a
crash or hang in a broken file cannot take the tagger down.

Usage:
  python3 -I tag-corpus.py [--manifest PATH] [--root DIR] [--jobs N] [--only ID[,ID...]]
                           [--source ID] [--dry-run]
  python3 -I tag-corpus.py --paths LIST.txt --out FACTS.jsonl   # ad-hoc scan of arbitrary files

The corpus root defaults to $BERGWORK_PDF_CORPUS or ~/AgentWork/bergwork-pdf-corpus.
Always run with `python3 -I` (the corpus consists of untrusted files).
"""

import argparse
import concurrent.futures as cf
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import unicodedata

TOOL_TIMEOUT = 20
PIKE_TIMEOUT = 45
TEXT_PAGE_LIMIT = 500   # textChars/scripts are computed from at most this many pages

GENRE_TAGS = {"presentation", "invoice", "scientific", "government-form", "book", "map", "cad"}
# Tags that cannot be derived reliably by the tagger and are therefore kept if present.
KEEP_TAGS = GENRE_TAGS

# Passwords used by the test suites the corpus is built from (pdf.js, PDFium, qpdf,
# PDFBox, pypdf sample-files, ...). Tried in order when a file is encrypted and the
# manifest does not record a password.
CANDIDATE_PASSWORDS = [
    "", "user", "owner", "test", "password", "view", "master", "asdfqwer", "asdfasdf",
    "qwerty", "foobar", "1234", "5678", "tiger", "a", "b", "u", "x", "y", "z", "pass",
    "quack", "attachment", "623", "19723102477", "Hello", "abc", "ELXRTQWS", "æøå",
    "pässwört", "SªSL­prep", "π", "ʬ", "ownerpass", "userpass", "testnutzer",
    "openpassword", "permissionpassword", "user3", "owner3", "12345", "key1", "key2",
    "test1", "test2", "secret", "pdfcpu", "upw", "opw", "0123456789abcdef", "hôtel", "âge", "SaSLprep",
    "Password\u5f33!", "Password\u5f53!", "Password\U0002F874!",
    "\uac00\u0323\u0300", "\uac00\u0300\u0323", "\u1100\u0300\u1161\u0323",
]

PAPER_SIZES = [  # portrait, in pt
    (612, 792), (612, 1008), (792, 1224), (1224, 1584), (522, 756), (396, 612),  # letter legal tabloid C exec statement
    (2384, 3370), (1684, 2384), (1191, 1684), (842, 1191), (595, 842), (420, 595), (298, 420), (210, 298),  # A0-A7
    (709, 1001), (499, 709), (354, 499),  # B4-B6 ISO
    (729, 1032), (516, 729),  # JIS B4/B5
    (459, 649), (649, 918), (312, 624), (279, 540),  # C5 C4 DL envelope #10-ish
]


def now_iso():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def run(cmd, timeout=TOOL_TIMEOUT, text=True):
    """Run a tool; return (returncode or 'timeout'/'error', stdout, stderr). Never raises."""
    try:
        p = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
        out, err, rc = p.stdout, p.stderr, p.returncode
    except subprocess.TimeoutExpired as e:
        out, err, rc = e.stdout or b"", e.stderr or b"", "timeout"
    except OSError as e:
        out, err, rc = b"", str(e).encode(), "error"
    if text:
        out = out.decode("utf-8", "replace")
        err = err.decode("utf-8", "replace")
    return rc, out, err


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- raw byte scan

def raw_scan(path, linearized):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        head = f.read(4096)
        if size <= 64 << 20:
            f.seek(0)
            data = f.read()
        else:  # very large file: scan first and last 32 MB only
            f.seek(0)
            data = f.read(32 << 20)
            f.seek(size - (32 << 20))
            data += f.read()
    m = re.search(rb"%PDF-(\d\.\d)", head)
    version = m.group(1).decode() if m else None
    startxrefs = len(re.findall(rb"startxref", data))
    incr = max(0, startxrefs - 1 - (1 if linearized else 0))
    return {
        "version": version,
        "headerOffset": m.start() if m else None,
        "xrefStream": bool(re.search(rb"/Type\s*/XRef\b", data)),
        "objStm": bool(re.search(rb"/Type\s*/ObjStm\b", data)),
        "incrementalUpdates": incr,
    }


# ---------------------------------------------------------------- poppler

def pw_args_poppler(password, owner, revision=None):
    """poppler takes the password bytes as given; for R<=4 they must be PDFDocEncoding (~Latin-1)."""
    def enc(pw):
        if revision is not None and revision <= 4:
            try:
                return pw.encode("latin-1")
            except UnicodeEncodeError:
                pass
        return pw.encode("utf-8")
    if owner:
        return [b"-opw", enc(owner)]
    if password:
        return [b"-upw", enc(password)]
    return []


def pdfinfo(path, pw):
    rc, out, err = run(["pdfinfo", *pw, "-f", "1", "-l", "100000", path])
    info = {"ok": rc == 0, "pages": None, "tagged": None, "form": None, "js": None,
            "producer": None, "sizes": [], "rots": 0, "version": None, "encrypted": None}
    if rc != 0 and not out:
        info["err"] = (err or str(rc))[:200]
        return info
    for line in out.splitlines():
        k, _, v = line.partition(":")
        v = v.strip()
        if k == "Pages":
            try:
                info["pages"] = int(v)
            except ValueError:
                pass
        elif k == "Tagged":
            info["tagged"] = v.startswith("yes")
        elif k == "Form":
            info["form"] = v
        elif k == "JavaScript":
            info["js"] = v.startswith("yes")
        elif k == "Producer":
            info["producer"] = v
        elif k == "PDF version":
            info["version"] = v
        elif k == "Encrypted":
            info["encrypted"] = v.startswith("yes")
        else:
            m = re.match(r"Page\s+\d+\s+size:\s+([\d.]+) x ([\d.]+)", line)
            if m:
                info["sizes"].append((float(m.group(1)), float(m.group(2))))
                continue
            m = re.match(r"Page\s+\d+\s+rot:\s+(-?\d+)", line)
            if m and int(m.group(1)) % 360 != 0:
                info["rots"] += 1
    return info


def split_fixed(lines):
    """Split poppler tabular output using the dashes line as column template."""
    rows = []
    if len(lines) < 2:
        return rows
    dash = lines[1]
    cols, i = [], 0
    for m in re.finditer(r"-+", dash):
        cols.append((m.start(), m.end()))
    for line in lines[2:]:
        if not line.strip():
            continue
        row = []
        for j, (s, e) in enumerate(cols):
            end = cols[j + 1][0] if j + 1 < len(cols) else len(line)
            row.append(line[s:end].strip())
        rows.append(row)
    return rows


def pdffonts(path, pw):
    rc, out, err = run(["pdffonts", *pw, path])
    f = {"type1": 0, "truetype": 0, "type3": 0, "cid": 0, "embedded": 0, "subset": 0, "notEmbedded": 0}
    rows = split_fixed(out.splitlines())
    for r in rows:
        if len(r) < 5:
            continue
        name, typ, emb, sub = r[0], r[1], r[3], r[4]
        if typ.startswith("CID"):
            f["cid"] += 1
        elif typ.startswith("Type 3"):
            f["type3"] += 1
        elif "TrueType" in typ:
            f["truetype"] += 1
        elif typ.startswith("Type 1"):
            f["type1"] += 1
        if emb == "yes":
            f["embedded"] += 1
        elif not typ.startswith("Type 3"):
            f["notEmbedded"] += 1
        if sub == "yes" or re.match(r"^[A-Z]{6}\+", name):
            f["subset"] += 1
    return f, (rc == 0)


def pdfimages(path, pw):
    rc, out, err = run(["pdfimages", *pw, "-list", path], timeout=60)
    rows = [l.split() for l in out.splitlines()[2:]]
    count, big, pages_with_big, max_page = 0, 0, set(), 0
    for r in rows:
        try:
            max_page = max(max_page, int(r[0]))
        except (ValueError, IndexError):
            pass
        if len(r) < 5 or r[2] not in ("image", "stencil"):
            continue
        count += 1
        try:
            w, h = int(r[3]), int(r[4])
        except ValueError:
            continue
        if w * h >= 4_000_000:
            big += 1
        if w * h >= 300_000:
            try:
                pages_with_big.add(int(r[0]))
            except ValueError:
                pass
    return {"images": count, "bigImages": big, "pagesWithLargeImage": len(pages_with_big),
            "complete": rc == 0, "pagesListed": max_page}


SCRIPT_RANGES = [
    ("cjk", [(0x3040, 0x30FF), (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xAC00, 0xD7AF),
             (0x1100, 0x11FF), (0xF900, 0xFAFF), (0x20000, 0x2FA1F), (0x3100, 0x312F), (0xFF66, 0xFF9F)]),
    ("arabic", [(0x0600, 0x06FF), (0x0750, 0x077F), (0x08A0, 0x08FF), (0xFB50, 0xFDFF), (0xFE70, 0xFEFF)]),
    ("hebrew", [(0x0590, 0x05FF), (0xFB1D, 0xFB4F)]),
    ("devanagari", [(0x0900, 0x097F), (0xA8E0, 0xA8FF)]),
    ("cyrillic", [(0x0400, 0x052F), (0x2DE0, 0x2DFF), (0xA640, 0xA69F)]),
    ("greek", [(0x0370, 0x03FF), (0x1F00, 0x1FFF)]),
    ("thai", [(0x0E00, 0x0E7F)]),
    ("latin", [(0x41, 0x5A), (0x61, 0x7A), (0xC0, 0x24F), (0x1E00, 0x1EFF)]),
]


def classify_text(text):
    counts = {k: 0 for k, _ in SCRIPT_RANGES}
    total = 0
    for ch in text:
        if ch.isspace():
            continue
        total += 1
        o = ord(ch)
        if o < 0x80:
            if 0x41 <= o <= 0x5A or 0x61 <= o <= 0x7A:
                counts["latin"] += 1
            continue
        for name, ranges in SCRIPT_RANGES:
            if any(a <= o <= b for a, b in ranges):
                counts[name] += 1
                break
    scripts = []
    for name, _ in SCRIPT_RANGES:
        c = counts[name]
        # Greek letters are common in formulas: require more evidence for greek.
        need = 200 if name == "greek" else 20
        if c >= need or (total and c / total >= 0.2 and c >= 5):
            scripts.append(name)
    return total, scripts


def pdftotext(path, pw, pages):
    last = min(pages or TEXT_PAGE_LIMIT, TEXT_PAGE_LIMIT)
    rc, out, err = run(["pdftotext", *pw, "-q", "-enc", "UTF-8", "-f", "1", "-l", str(last), path, "-"])
    if rc == "timeout" and last > 30:
        rc, out, err = run(["pdftotext", *pw, "-q", "-enc", "UTF-8", "-f", "1", "-l", "30", path, "-"])
    out = unicodedata.normalize("NFC", out.replace("�", ""))
    return classify_text(out)


# ---------------------------------------------------------------- qpdf

def qpdf_pw(password, owner):
    p = owner if owner else password
    return [f"--password={p}"] if p else []


def qpdf_check(path, pw, big):
    rc, out, err = run(["qpdf", *pw, "--check", path], timeout=120 if big else 60)
    msg = out + err
    if rc == 0:
        state = "ok"
    elif rc == 3:
        state = "warnings"
    elif rc == "timeout":
        state = "warnings"
        msg = "qpdf --check timed out"
    else:
        state = "errors"
    damaged = bool(re.search(r"damaged|reconstruct|recovered|attempting to recover|xref not found|"
                             r"unable to find trailer|EOF", msg, re.I))
    return state, damaged, msg[-500:]


def qpdf_linearized(path, pw):
    # qpdf 12 has no --is-linearized; --check-linearization says "is not linearized" otherwise.
    rc, out, err = run(["qpdf", *pw, "--check-linearization", path])
    msg = out + err
    if rc == "timeout" or "is not linearized" in msg:
        return False
    return "linearization" in msg


def qpdf_encryption(path, pw):
    rc, out, err = run(["qpdf", *pw, "--show-encryption", path])
    if rc not in (0, 3) or "File is not encrypted" in out:
        return None
    enc = {}
    m = re.search(r"R = (\d+)", out)
    if m:
        enc["R"] = int(m.group(1))
    m = re.search(r"P = (-?\d+)", out)
    if m:
        enc["P"] = int(m.group(1))
    m = re.search(r"stream encryption method: (\S+)", out)
    if m:
        enc["method"] = m.group(1)
    return enc or None


# ---------------------------------------------------------------- pikepdf worker

PIKE_WORKER = r'''
import json, re, sys
import pikepdf
from pikepdf import Name, Dictionary, Array, Stream

path, pwjson = sys.argv[1], sys.argv[2]
cands = json.loads(pwjson)
res = {"open": False}
pdf = None
def variants(pw):
    yield pw
    try:
        b = pw.encode("latin-1")
        if b != pw.encode("utf-8"):
            yield b  # R<=4 passwords are PDFDocEncoding bytes
    except UnicodeEncodeError:
        pass
tries = [(pw, v) for pw in cands for v in variants(pw)]
for i, (pw, v) in enumerate(tries):
    try:
        pdf = pikepdf.open(path, password=v, suppress_warnings=True)
        res["passwordUsed"] = pw
        break
    except pikepdf.PasswordError:
        res["needsPassword"] = True
        continue
    except Exception as e:
        res["error"] = (type(e).__name__ + ": " + str(e))[:300]
        break
if pdf is None:
    print(json.dumps(res)); sys.exit(0)
res["open"] = True
try:
    res["ownerMatched"] = bool(pdf.owner_password_matched)
    res["userMatched"] = bool(pdf.user_password_matched)
except Exception:
    pass
try:
    res["encrypted"] = bool(pdf.is_encrypted)
except Exception:
    res["encrypted"] = None
try:
    ei = pdf.encryption
    if pdf.is_encrypted:
        res["enc"] = {"bits": int(ei.bits), "R": int(ei.R), "V": int(ei.V),
                      "method": str(ei.stream_method).split(".")[-1]}
except Exception:
    pass

root = pdf.Root
def has(d, k):
    try:
        return k in d
    except Exception:
        return False
def get(d, k, default=None):
    try:
        return d.get(k, default)
    except Exception:
        return default

res["pages"] = None
try:
    res["pages"] = len(pdf.pages)
except Exception:
    pass

af = get(root, "/AcroForm")
fields = get(af, "/Fields") if af is not None else None
res["xfa"] = bool(af is not None and has(af, "/XFA"))
nfields = 0
sigs = 0
def walk(fs, depth=0, ft_inh=None):
    global nfields, sigs
    if fs is None or depth > 30:
        return
    try:
        it = list(fs)
    except Exception:
        return
    for f in it:
        try:
            ft = get(f, "/FT", ft_inh)
            kids = get(f, "/Kids")
            nfields += 1
            if ft == Name.Sig and has(f, "/V"):
                sigs += 1
            if kids is not None:
                walk(kids, depth + 1, ft)
        except Exception:
            pass
        if nfields > 20000:
            return
walk(fields)
res["acroform"] = bool(nfields > 0 or res["xfa"])
res["signatures"] = sigs

mi = get(root, "/MarkInfo")
res["marked"] = bool(mi is not None and get(mi, "/Marked") is True)
res["structTree"] = has(root, "/StructTreeRoot")
ol = get(root, "/Outlines")
res["outline"] = bool(ol is not None and has(ol, "/First"))
res["ocg"] = has(root, "/OCProperties")
names = get(root, "/Names")
res["embeddedFiles"] = bool(names is not None and has(names, "/EmbeddedFiles"))
res["javascript"] = bool(names is not None and has(names, "/JavaScript"))
oa = get(root, "/OpenAction")
try:
    if isinstance(oa, Dictionary) and get(oa, "/S") == Name.JavaScript:
        res["javascript"] = True
except Exception:
    pass
if has(root, "/AA"):
    res["javascript"] = True

annots, subtypes = 0, {}
rot = 0
maxsz = [0, 0]
paths = texts = 0
invisible = False
transparency = False
try:
    for pi, page in enumerate(pdf.pages):
        if pi >= 3000:
            break
        try:
            a = get(page.obj, "/Annots")
            if a is not None:
                for an in a:
                    annots += 1
                    st = str(get(an, "/Subtype", "/None"))
                    subtypes[st] = subtypes.get(st, 0) + 1
                    if st == "/FileAttachment":
                        res["embeddedFiles"] = True
                    act = get(an, "/A")
                    if act is not None and get(act, "/S") == Name.JavaScript:
                        res["javascript"] = True
        except Exception:
            pass
        try:
            g = get(page.obj, "/Group")
            if g is not None and get(g, "/S") == Name.Transparency:
                transparency = True
        except Exception:
            pass
        if pi < 4:
            try:
                c = get(page.obj, "/Contents")
                data = c.read_bytes() if isinstance(c, Stream) else b"".join(x.read_bytes() for x in c)
                data = data[:8 << 20]
                # include Form XObjects (maps/CAD exports often put everything there), bounded
                stack, seen_x, budget = [(get(page.obj, "/Resources"), 0)], set(), 16 << 20
                while stack and budget > 0:
                    resd, depth = stack.pop()
                    xo = get(resd, "/XObject") if resd is not None else None
                    if xo is None or depth > 3:
                        continue
                    for k in list(xo.keys())[:200]:
                        x = xo[k]
                        try:
                            og = x.objgen
                        except Exception:
                            og = None
                        if og in seen_x or not isinstance(x, Stream) or get(x, "/Subtype") != Name.Form:
                            continue
                        seen_x.add(og)
                        b = x.read_bytes()[:budget]
                        budget -= len(b)
                        data += b"\n" + b
                        stack.append((get(x, "/Resources"), depth + 1))
                paths += len(re.findall(rb"(?<![A-Za-z/])(?:m|l|c|v|y|re)(?=[\s\[\]/(<])", data))
                texts += len(re.findall(rb"(?<![A-Za-z/])(?:Tj|TJ|'|\")(?=[\s\[\]/(<])", data))
                if re.search(rb"(?<![\d.])3\s+Tr\b", data):
                    invisible = True
            except Exception:
                pass
except Exception as e:
    res["pageError"] = str(e)[:200]
res["annotations"] = annots
res["annotSubtypes"] = subtypes
res["samplePathOps"] = paths
res["sampleTextOps"] = texts
res["invisibleText"] = invisible

# object sweep (bounded)
mm = set()
js_obj = False
seen = 0
try:
    for obj in pdf.objects:
        seen += 1
        if seen > 300000:
            break
        try:
            if not isinstance(obj, (Dictionary, Stream)):
                continue
            d = obj if isinstance(obj, Dictionary) else obj.stream_dict
            st = get(d, "/Subtype")
            if st is not None and str(st) in ("/RichMedia", "/Movie", "/Sound", "/Screen", "/3D"):
                mm.add(str(st))
            if has(d, "/JS"):
                js_obj = True
            t = get(d, "/Type")
            if t == Name.ExtGState:
                sm = get(d, "/SMask")
                if sm is not None and sm != Name("/None"):
                    transparency = True
                for k in ("/CA", "/ca"):
                    v = get(d, k)
                    if v is not None and float(v) < 1:
                        transparency = True
                bm = get(d, "/BM")
                if bm is not None and str(bm) not in ("/Normal", "/Compatible", "[ /Normal ]"):
                    transparency = True
            if isinstance(obj, Stream) and st == Name.Image and has(d, "/SMask"):
                transparency = True
            g = get(d, "/Group")
            if isinstance(g, Dictionary) and get(g, "/S") == Name.Transparency:
                transparency = True
        except Exception:
            pass
except Exception:
    pass
res["multimedia"] = sorted(mm)
res["javascript"] = bool(res["javascript"] or js_obj)
res["transparency"] = transparency

res["producer"] = None
try:
    info = pdf.trailer.get("/Info")
    p = info.get("/Producer") if info is not None else None
    res["producer"] = str(p) if p is not None else None
except Exception:
    pass
res["pdfa"] = None
res["pdfua"] = False
try:
    with pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=False, strict=False) as meta:
        part = meta.get("pdfaid:part")
        conf = meta.get("pdfaid:conformance")
        if part:
            res["pdfa"] = str(part) + (str(conf).upper() if conf else "")
        if meta.get("pdfuaid:part"):
            res["pdfua"] = True
        res["xmpProducer"] = meta.get("pdf:Producer")
except Exception:
    pass
print(json.dumps(res, default=str))
'''


def pike_analyse(path, candidates):
    cmd = [sys.executable, "-I", "-c", PIKE_WORKER, path, json.dumps(candidates)]
    rc, out, err = run(cmd, timeout=PIKE_TIMEOUT)
    try:
        return json.loads(out.strip().splitlines()[-1])
    except Exception:
        return {"open": False, "error": f"pikepdf worker failed ({rc}): {err[-200:]}"}


# ---------------------------------------------------------------- per-file analysis

def near_standard(w, h):
    a, b = sorted((w, h))
    return any(abs(a - x) <= 4 and abs(b - y) <= 4 for x, y in PAPER_SIZES)


def analyse(path, password=None, owner=None):
    size = os.path.getsize(path)
    big = size >= 20 << 20
    # password discovery
    cands = []
    if owner is not None:
        cands.append(owner)
    if password is not None:
        cands.append(password)
    cands += [c for c in CANDIDATE_PASSWORDS if c not in cands]
    pk = pike_analyse(path, cands)
    if pk.get("open") and pk.get("encrypted") and (password is None or owner is None):
        user_pw, owner_pw = pike_probe(path, cands)
        if password is None:
            password = user_pw
        if owner is None:
            owner = owner_pw
    ppw = pw_args_poppler(password, owner, (pk.get("enc") or {}).get("R"))
    qpw = qpdf_pw(password, owner)

    linearized = qpdf_linearized(path, qpw)
    raw = raw_scan(path, linearized)
    info = pdfinfo(path, ppw)
    check, damaged, checkmsg = qpdf_check(path, qpw, big)
    enc_q = qpdf_encryption(path, qpw)
    fonts, fonts_ok = pdffonts(path, ppw)
    imgs = pdfimages(path, ppw)
    pages = info["pages"] if info["pages"] is not None else pk.get("pages")
    text_chars, scripts = (0, [])
    if info["ok"] or pk.get("open"):
        text_chars, scripts = pdftotext(path, ppw, pages)

    sizes = info["sizes"]
    max_size = None
    if sizes:
        max_size = [round(max(w for w, h in sizes)), round(max(h for w, h in sizes))]
    odd = any(not near_standard(w, h) for w, h in sizes[:3000]) if sizes else False

    encrypted = bool(pk.get("encrypted") or info.get("encrypted") or enc_q)
    acroform = bool(pk.get("acroform") or (info.get("form") in ("AcroForm", "XFA")))
    xfa = bool(pk.get("xfa") or info.get("form") == "XFA")
    tagged = bool(info.get("tagged") or pk.get("marked") or pk.get("structTree"))
    enc_detail = None
    if encrypted:
        enc_detail = dict(pk.get("enc") or {})
        if enc_q:
            enc_detail.setdefault("R", enc_q.get("R"))
            if enc_q.get("method"):
                enc_detail["method"] = enc_q["method"]
            if "P" in enc_q:
                enc_detail["P"] = enc_q["P"]
        if enc_detail.get("method") in (None, "none") and enc_detail.get("R") in (2, 3):
            enc_detail["method"] = "RC4"
    facts = {
        "qpdfCheck": check,
        "encrypted": encrypted,
        "linearized": linearized,
        "tagged": tagged,
        "acroform": acroform,
        "xfa": xfa,
        "annotations": pk.get("annotations", 0) or 0,
        "fonts": fonts,
        "images": imgs["images"],
        "textChars": text_chars,
        "scripts": scripts,
        "incrementalUpdates": raw["incrementalUpdates"],
        "pdfa": pk.get("pdfa"),
        "pdfua": bool(pk.get("pdfua")),
        "signatures": pk.get("signatures", 0) or 0,
        "maxPageSizePt": max_size,
        "rotatedPages": info["rots"],
        # extra (not in the minimal schema, but useful):
        "encryption": enc_detail,
        "annotationSubtypes": {k.lstrip("/"): v for k, v in sorted((pk.get("annotSubtypes") or {}).items())},
        "bigImages": imgs["bigImages"],
        "openedBy": {"pikepdf": bool(pk.get("open")), "poppler": bool(info["ok"])},
    }
    if not pk.get("open") and pk.get("error"):
        facts["pikepdfError"] = pk["error"][:200]
    if check != "ok":
        facts["qpdfMessage"] = checkmsg.strip().splitlines()[-1][:200] if checkmsg.strip() else ""

    # ---- tags
    tags = set()
    version = raw["version"] or info.get("version")
    if version and re.fullmatch(r"1\.[0-7]|2\.0", version):
        tags.add("pdf-" + version)
    if facts["pdfa"]:
        tags.add("pdfa")
    if facts["pdfua"]:
        tags.add("pdfua")
    tags.add("tagged" if tagged else "untagged")
    np = pages or 0
    if text_chars >= 50:
        tags.add("text")
    # if pdfimages timed out, judge on the pages it got through
    img_pages = np if imgs["complete"] else min(np, imgs["pagesListed"])
    scanned_like = img_pages > 0 and imgs["pagesWithLargeImage"] >= max(1, 0.8 * img_pages)
    if scanned_like and text_chars < 30 * max(min(np, TEXT_PAGE_LIMIT), 1):
        tags.add("scanned")
    elif scanned_like and pk.get("invisibleText") and text_chars >= 30:
        tags.add("ocr-layer")
    for s in scripts:
        if s != "latin":
            tags.add(s)
    if "arabic" in scripts or "hebrew" in scripts:
        tags.add("rtl")
    if fonts["type1"]:
        tags.add("font-type1")
    if fonts["truetype"]:
        tags.add("font-truetype")
    if fonts["type3"]:
        tags.add("font-type3")
    if fonts["cid"]:
        tags.add("font-cid")
    if fonts["subset"]:
        tags.add("font-subset")
    if fonts["notEmbedded"]:
        tags.add("font-not-embedded")
    if acroform:
        tags.add("acroform")
    if xfa:
        tags.add("xfa")
    if facts["signatures"]:
        tags.add("signed")
    if facts["annotations"]:
        tags.add("annotations")
    if (pk.get("annotSubtypes") or {}).get("/Link"):
        tags.add("links")
    if pk.get("outline"):
        tags.add("outline")
    if encrypted:
        tags.add("encrypted")
        if password:
            tags.add("encrypted-user-password")
        elif password == "" or (pk.get("open") and pk.get("passwordUsed") == ""):
            tags.add("encrypted-owner-only")
        else:
            tags.add("encrypted-user-password")
    if linearized:
        tags.add("linearized")
    if raw["incrementalUpdates"]:
        tags.add("incremental")
    if raw["objStm"]:
        tags.add("object-streams")
    if raw["xrefStream"]:
        tags.add("xref-stream")
    pw_unknown = encrypted and not pk.get("open") and bool(pk.get("needsPassword"))
    if pw_unknown:
        facts["passwordUnknown"] = True
    if (check == "errors" and not pw_unknown) or damaged or (raw["headerOffset"] or 0) > 0 or raw["version"] is None:
        tags.add("broken")
    if np >= 200:
        tags.add("many-pages")
    if size >= 20 << 20:
        tags.add("large-file")
    if imgs["bigImages"]:
        tags.add("big-images")
    po, to = pk.get("samplePathOps", 0), pk.get("sampleTextOps", 0)
    sample_pages = min(np, 4) or 1
    chars_per_page = text_chars / max(min(np, TEXT_PAGE_LIMIT), 1)
    if po >= 2000 * sample_pages and po >= 10 * max(to, 1) and 3 * chars_per_page < po / sample_pages:
        tags.add("vector-heavy")
    if info["rots"]:
        tags.add("rotated-pages")
    if odd:
        tags.add("odd-page-size")
    if pk.get("transparency"):
        tags.add("transparency")
    if pk.get("ocg"):
        tags.add("layers-ocg")
    if pk.get("embeddedFiles"):
        tags.add("embedded-files")
    if pk.get("javascript") or info.get("js"):
        tags.add("javascript")
    if pk.get("multimedia"):
        tags.add("multimedia")

    producer = pk.get("producer") or info.get("producer") or pk.get("xmpProducer")
    if producer:
        producer = re.sub(r"[\x00-\x1f]", " ", str(producer)).strip()[:80] or None
    open_fail = not pk.get("open") and not info["ok"] and check == "errors" and not pw_unknown
    return {
        "sha256": sha256_file(path),
        "bytes": size,
        "pages": pages,
        "pdfVersion": version,
        "producer": producer,
        "password": password if encrypted else None,
        "ownerPassword": owner if encrypted else None,
        "facts": facts,
        "tags": tags,
        "openFail": open_fail,
    }


PROBE_WORKER = r'''
import json, sys, pikepdf
user = owner = None
def variants(pw):
    yield pw
    try:
        b = pw.encode("latin-1")
        if b != pw.encode("utf-8"):
            yield b
    except UnicodeEncodeError:
        pass
for pw, v in [(pw, v) for pw in json.loads(sys.argv[2]) for v in variants(pw)]:
    try:
        p = pikepdf.open(sys.argv[1], password=v)
    except Exception:
        continue
    if user is None and p.user_password_matched:
        user = pw
    if owner is None and p.owner_password_matched:
        owner = pw
    p.close()
    if user is not None and owner is not None:
        break
print(json.dumps([user, owner]))
'''


def pike_probe(path, cands):
    """Return (user password, owner password) among the candidates, None when not found."""
    rc, out, err = run([sys.executable, "-I", "-c", PROBE_WORKER, path, json.dumps(cands)], timeout=PIKE_TIMEOUT)
    try:
        u, o = json.loads(out.strip().splitlines()[-1])
        return u, o
    except Exception:
        return None, None


AUTO_NOTE_PREFIX = "auto:"
AUTO_NOTE = "auto: qpdf, poppler and pikepdf all fail to open this file"


def order_tags(tags):
    return sorted(tags)


def apply(entry, r):
    entry["sha256"] = r["sha256"]
    entry["bytes"] = r["bytes"]
    entry["pages"] = r["pages"]
    entry["pdfVersion"] = r["pdfVersion"]
    entry["producer"] = r["producer"]
    if entry.get("password") is None:
        entry["password"] = r["password"]
    if entry.get("ownerPassword") is None:
        entry["ownerPassword"] = r["ownerPassword"]
    keep = {t for t in entry.get("tags", []) if t in KEEP_TAGS}
    entry["tags"] = order_tags(r["tags"] | keep)
    entry["facts"] = r["facts"]
    exp = entry.get("expect")
    auto = isinstance(exp, dict) and str(exp.get("note", "")).startswith(AUTO_NOTE_PREFIX)
    if r["openFail"]:
        if not exp:
            entry["expect"] = {"open": "fail", "note": AUTO_NOTE}
    elif auto:
        entry["expect"] = None
    return entry


def corpus_root(arg):
    root = arg or os.environ.get("BERGWORK_PDF_CORPUS") or "~/AgentWork/bergwork-pdf-corpus"
    return os.path.expanduser(root)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", default=os.path.join(here, "manifest.json"))
    ap.add_argument("--root")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--only", help="comma-separated file ids")
    ap.add_argument("--source", help="only entries of this source id")
    ap.add_argument("--dry-run", action="store_true", help="do not write the manifest")
    ap.add_argument("--paths", help="scan the files listed in this text file instead of the manifest")
    ap.add_argument("--out", help="JSONL output for --paths mode")
    a = ap.parse_args()

    if a.paths:
        paths = [l.rstrip("\n") for l in open(a.paths, encoding="utf-8") if l.strip()]
        done = set()
        if a.out and os.path.exists(a.out):
            for l in open(a.out, encoding="utf-8"):
                try:
                    done.add(json.loads(l)["path"])
                except Exception:
                    pass
        todo = [p for p in paths if p not in done]
        out = open(a.out, "a", encoding="utf-8") if a.out else sys.stdout
        with cf.ThreadPoolExecutor(a.jobs) as ex:
            futs = {ex.submit(analyse, p): p for p in todo}
            for i, fu in enumerate(cf.as_completed(futs), 1):
                p = futs[fu]
                try:
                    r = fu.result()
                    r["tags"] = sorted(r["tags"])
                except Exception as e:
                    r = {"error": repr(e)[:300]}
                r["path"] = p
                out.write(json.dumps(r, ensure_ascii=False) + "\n")
                out.flush()
                if i % 50 == 0:
                    print(f"{i}/{len(todo)}", file=sys.stderr, flush=True)
        return 0

    root = corpus_root(a.root)
    with open(a.manifest, encoding="utf-8") as f:
        man = json.load(f)
    only = set(a.only.split(",")) if a.only else None
    entries = [e for e in man["files"]
               if (not only or e["id"] in only) and (not a.source or e["source"] == a.source)]
    missing, failed = [], []

    def work(e):
        p = os.path.join(root, e["id"])
        if not os.path.exists(p):
            return e, None, "missing"
        try:
            return e, analyse(p, e.get("password"), e.get("ownerPassword")), None
        except Exception as ex:
            return e, None, repr(ex)

    with cf.ThreadPoolExecutor(a.jobs) as ex:
        for i, (e, r, err) in enumerate(ex.map(work, entries), 1):
            if err == "missing":
                missing.append(e["id"])
            elif err:
                failed.append((e["id"], err))
            else:
                apply(e, r)
            if i % 50 == 0:
                print(f"tagged {i}/{len(entries)}", file=sys.stderr, flush=True)
    man["generated"] = now_iso()
    if not a.dry_run:
        tmp = a.manifest + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(man, f, ensure_ascii=False, indent=1)
            f.write("\n")
        os.replace(tmp, a.manifest)
    print(f"tagged {len(entries) - len(missing) - len(failed)} files, missing {len(missing)}, failed {len(failed)}")
    for m in missing[:20]:
        print("  missing:", m)
    for i, err in failed[:20]:
        print("  failed:", i, err)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
