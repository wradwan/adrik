#!/usr/bin/env python3
"""Adrik computer reader: sends what a person's own Chrome read on a mosque site to the Scout (rule computer-reader).

Runs on Wael's computer (Cowork shell), so the admin token in C:\\dev\\adrik\\.env never leaves it.
  python3 pc_ingest.py list                                        mosques to read in the computer's browser (JSON)
  python3 pc_ingest.py read --id UUID --url URL < reading.json     reading.json = pc-reader.js output, verbatim
  python3 pc_ingest.py closed --id UUID --url URL --reason TEXT    the site refuses a normal browser too (403/404/5xx)
"""
import argparse, json, os, sys, urllib.error, urllib.request

API = "https://fbowvnwytutltsdnjcxb.supabase.co/functions/v1/scout"
# Public anon key (the same one the web app ships); the function also requires the admin token.
ANON = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZib3d2bnd5dHV0bHRzZG5qY3hiIiwicm9sZSI6ImFub24i"
        "LCJpYXQiOjE3OTI5MzIzNDEsImV4cCI6MjEwODUwODM0MX0.nLpuv5rDvdka8tfuZ3Ic_T1SdceNtPDTzfhkg6NEYVc")


def token():
    here = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else ""
    candidates = [os.environ.get("ADRIK_ENV", ""), os.path.join(here, "..", "..", ".env"), os.path.expanduser("~/mnt/dev/adrik/.env")]
    for p in candidates:
        if p and os.path.isfile(p):
            for line in open(p, encoding="utf-8"):
                if line.startswith("ADRIK_SCOUT_ADMIN_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"')
    sys.exit("ADRIK_SCOUT_ADMIN_TOKEN not found (looked in " + ", ".join(c for c in candidates if c) + ")")


def call(body):
    req = urllib.request.Request(API, data=json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {ANON}", "x-adrik-admin": token()})
    try:
        with urllib.request.urlopen(req, timeout=170) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"Scout error HTTP {e.code}: {e.read().decode()[:300]}")


def fnv(s):
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, "x")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["list", "read", "closed"])
    ap.add_argument("--id")
    ap.add_argument("--url")
    ap.add_argument("--reason", default="")
    a = ap.parse_args()

    if a.cmd == "list":
        print(json.dumps(call({"mode": "targets"}).get("computer", []), ensure_ascii=False, indent=1))
        return
    if not a.id:
        sys.exit("--id is required")
    if a.cmd == "closed":
        r = call({"mode": "blocked", "source": "pc-chrome", "mosque_id": a.id, "url": a.url, "reason": a.reason or "refused a normal browser"})
        print(json.dumps(r))
        return

    raw = sys.stdin.read().strip()
    d = json.loads(json.loads(raw) if raw.startswith('"') else raw)   # accept the tool's JSON string either way
    if d.get("challenge") or d.get("closed"):
        sys.exit(f"not a reading: {d}")
    text = "\n=====\n".join(d.get("blocks", [])) + "\n#####\n" + "\n".join(d.get("jumuah", []))
    if fnv(text) != d.get("check"):
        sys.exit(f"CHECKSUM MISMATCH ({fnv(text)} != {d.get('check')}): the reading was not copied exactly; re-run pc-reader.js and pass its output unchanged")
    if not d.get("blocks"):
        sys.exit("no prayer-time block found on the page")
    page = d.get("url") or a.url
    msg = (f"=== {page} — {d.get('title', '')} ===\n" + (f"(opened by clicking: {', '.join(d['clicked'])})\n" if d.get("clicked") else "") +
           "\n\n".join(d["blocks"]) + ("\n\n--- Jumu'ah lines on the page ---\n" + "\n".join(d["jumuah"]) if d.get("jumuah") else ""))
    r = call({"mode": "ingest", "source": "pc-chrome", "mosque_id": a.id, "url": page, "text": msg})
    keep = {k: r.get(k) for k in ["status", "rows", "rules", "jumuah", "confidence", "stored_as", "needs_review", "resolved_today", "error"]}
    print(json.dumps(keep, ensure_ascii=False))


main()
