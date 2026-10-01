#!/usr/bin/env python3
"""Fetch the current monthly program of Jugoslovenska kinoteka, parse it and publish JSON for the site.

    python scraper/update.py                  # regular run (GitHub Actions, every few hours)
    python scraper/update.py --pdf URL [URL]  # import specific PDFs, e.g. to backfill older months
    python scraper/update.py --force          # re-parse and refresh ratings even if nothing changed
"""
import argparse
import hashlib
import json
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from imdb import Enricher, apply_ratings, fetch_ratings, program_imdb_ids  # noqa: E402
from kinoteka_pdf import parse_program, pdf_lines  # noqa: E402
from text import fold  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"
PROGRAMS = DATA / "programs"
CACHE = ROOT / "scraper" / "cache"
STATE_PATH = CACHE / "state.json"
OVERRIDES_PATH = ROOT / "scraper" / "imdb_overrides.json"
PAGE_URL = "https://www.kinoteka.org.rs/repertoar-programi/"
PARSER_VERSION = 1  # bump to re-parse the current PDF after parser changes
RATINGS_EVERY_DAYS = 7

http = requests.Session()
http.headers["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)"


def log(*a):
    print(*a, flush=True)


def get(url: str) -> requests.Response:
    r = http.get(url, timeout=60)
    r.raise_for_status()
    return r


def read_json(path: Path, default):
    return json.loads(path.read_text("utf-8")) if path.exists() else default


def write_json(path: Path, data, compact: bool = False) -> bool:
    """Write only when the content changed (keeps the git history quiet). Returns True if written."""
    text = (json.dumps(data, ensure_ascii=False, separators=(",", ":")) if compact
            else json.dumps(data, ensure_ascii=False, indent=1)) + "\n"
    if path.exists() and path.read_text("utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, "utf-8")
    return True


def find_pdf_url(html: str) -> str:
    for m in re.finditer(r'<a\b[^>]*href="([^"]+\.pdf)"[^>]*>(.*?)</a>', html, re.S | re.I):
        if "mesecni program" in fold(re.sub(r"<[^>]+>", " ", m.group(2))):
            return urljoin(PAGE_URL, m.group(1))
    # fallback: a PDF named like KINOTEKA_OKTOBAR_2026_PROGRAM.pdf
    for url in re.findall(r'href="([^"]+\.pdf)"', html, re.I):
        if re.search(r"kinoteka[^/]*program", url, re.I):
            return urljoin(PAGE_URL, url)
    raise RuntimeError(f"Na stranici {PAGE_URL} nije pronađen link ka mesečnom programu (PDF).")


def load_programs() -> dict[str, dict]:
    return {p.stem: read_json(p, None) for p in sorted(PROGRAMS.glob("*.json"))}


def parse_pdf(pdf_url: str, pdf: bytes) -> dict:
    program = parse_program(pdf_lines(pdf))
    days_with_slots = [d for d in program["days"] if d["slots"]]
    if len(days_with_slots) < 5:
        raise RuntimeError(f"PDF {pdf_url} je parsiran u samo {len(days_with_slots)} dana sa projekcijama "
                           "- format se verovatno promenio, parser treba doraditi.")
    for w in program.pop("warnings", []):
        log("  upozorenje:", w)
    program["id"] = program["first_date"][:7]
    program["source_pdf"] = pdf_url
    program["source_page"] = PAGE_URL
    program["pdf_sha256"] = hashlib.sha256(pdf).hexdigest()
    program["parsed_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return program


def merged_days(programs: dict[str, dict]) -> dict[str, tuple[dict, dict]]:
    """date -> (day, program). For dates covered by two PDFs the newer program wins."""
    out = {}
    for prog in sorted(programs.values(), key=lambda p: (p["first_date"], p.get("parsed_at", ""))):
        for day in prog["days"]:
            out[day["date"]] = (day, prog)
    return out


def build_screenings(programs: dict[str, dict]) -> list[dict]:
    """Flat list of upcoming screenings, read by the e-mail notifier (Google Apps Script)."""
    since = (date.today() - timedelta(days=1)).isoformat()
    out = []
    for d, (day, prog) in sorted(merged_days(programs).items()):
        if d < since:
            continue
        for s in day["slots"]:
            out.append({
                "id": s["id"], "date": d, "times": s["times"], "end": s["end"], "section": s["section"],
                "label": s["label"],
                "films": [{
                    "title": f["title"], "original_title": f["original_title"], "year": f["year"],
                    "imdb_id": (f.get("imdb") or {}).get("id"), "imdb_title": (f.get("imdb") or {}).get("title"),
                    "rating": (f.get("imdb") or {}).get("rating"), "poster": (f.get("imdb") or {}).get("poster"),
                } for f in s["films"]],
            })
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", nargs="+", help="import these PDF URLs instead of the one linked on the site")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    state = read_json(STATE_PATH, {})
    programs = load_programs()
    enricher = Enricher(CACHE / "imdb.json", OVERRIDES_PATH)
    changed: dict[str, dict] = {}

    for src in args.pdf or [None]:
        pdf_url = src or find_pdf_url(get(PAGE_URL).text)
        log("PDF:", pdf_url)
        pdf = get(pdf_url).content
        sha = hashlib.sha256(pdf).hexdigest()
        if (src is None and not args.force and state.get("pdf_sha256") == sha
                and state.get("parser_version") == PARSER_VERSION and state.get("program_id") in programs):
            log("  bez promena")
            continue
        program = parse_pdf(pdf_url, pdf)
        n_films = sum(len(s["films"]) for d in program["days"] for s in d["slots"])
        log(f"  {program['title']}: {program['first_date']} - {program['last_date']}, {n_films} filmova")
        enricher.enrich_program(program)
        old = programs.get(program["id"])
        if old:  # keep known ratings until the next ratings refresh
            known = {f["imdb"]["id"]: f["imdb"] for d in old["days"] for s in d["slots"] for f in s["films"]
                     if f.get("imdb")}
            for d in program["days"]:
                for s in d["slots"]:
                    for f in s["films"]:
                        if f.get("imdb") and f["imdb"]["id"] in known and f["imdb"]["rating"] is None:
                            f["imdb"]["rating"] = known[f["imdb"]["id"]].get("rating")
                            f["imdb"]["votes"] = known[f["imdb"]["id"]].get("votes")
        programs[program["id"]] = changed[program["id"]] = program
        if src is None:
            state.update(pdf_url=pdf_url, pdf_sha256=sha, parser_version=PARSER_VERSION, program_id=program["id"])
    enricher.save()
    log(f"IMDb pretrage: {enricher.lookups}")

    last = state.get("ratings_date")
    if changed or args.force or not last or date.fromisoformat(last) <= date.today() - timedelta(RATINGS_EVERY_DAYS):
        ids = set().union(*(program_imdb_ids(p) for p in programs.values())) if programs else set()
        log(f"Osvežavam IMDb ocene za {len(ids)} naslova...")
        ratings = fetch_ratings(ids)
        for pid, prog in programs.items():
            apply_ratings(prog, ratings)
            changed.setdefault(pid, prog)
        state["ratings_date"] = date.today().isoformat()

    written = [pid for pid, prog in changed.items() if write_json(PROGRAMS / f"{pid}.json", prog)]
    index = {
        "programs": [{
            "id": p["id"], "title": p["title"], "first_date": p["first_date"], "last_date": p["last_date"],
            "file": f"programs/{p['id']}.json", "source_pdf": p["source_pdf"], "parsed_at": p["parsed_at"],
        } for p in sorted(programs.values(), key=lambda p: p["first_date"])],
    }
    write_json(DATA / "index.json", index)
    if written or not (DATA / "screenings.json").exists():
        write_json(DATA / "screenings.json", {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "screenings": build_screenings(programs),
        }, compact=True)
    write_json(STATE_PATH, state)
    log("Izmenjeni programi:", ", ".join(written) or "nema")
    return 0


if __name__ == "__main__":
    sys.exit(main())
