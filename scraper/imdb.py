"""IMDb enrichment (poster, rating) without API keys.

* search: IMDb's public autocomplete endpoint -> id, title, year, poster, top stars
* ratings: IMDb's official dataset title.ratings.tsv.gz (free for personal, non-commercial use)

Matches are scored by year (+-2), title similarity and overlap between the cast from the
PDF and the stars IMDb returns. Wrong or missing matches can be fixed in imdb_overrides.json.
"""
import gzip
import io
import json
import re
import time
import urllib.parse
from datetime import date, timedelta
from difflib import SequenceMatcher
from pathlib import Path

import requests

from text import fold, latinize, search_key

SUGGEST_URL = "https://v3.sg.media-imdb.com/suggestion/x/{q}.json"
RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz"
TYPE_BONUS = {"movie": 1.0, "tvMovie": 0.4, "short": 0.4, "video": 0.2, "tvSpecial": 0.2, "tvShort": 0.2,
              "tvMiniSeries": -0.5}
RETRY_MISSES_AFTER_DAYS = 14
EXTRAS = ("making of", "behind the scenes", "featurette", "interactive", "the story of", "documentary on")
STOPWORDS = {"the", "a", "an", "la", "le", "les", "l", "el", "il", "lo", "der", "die", "das", "de", "du", "des",
             "of", "i", "u", "and"}

session = requests.Session()
session.headers["User-Agent"] = "Mozilla/5.0 (kinoteka-kalendar; +https://github.com)"


def film_key(film: dict) -> str:
    return f"{search_key(film['title'])}|{film.get('year') or ''}"


def poster_url(url: str | None, width: int = 300) -> str | None:
    if not url:
        return None
    return re.sub(r"\._V1_.*?\.(jpg|png)$", rf"._V1_QL75_UX{width}_.\1", url)


def _query_text(s: str) -> str:
    s = fold(s)
    s = re.sub(r"[^\w' ]+", " ", s)
    return " ".join(s.split()[:6])


def title_similarity(a: str, b: str) -> float:
    """Character similarity, capped by how many (fuzzy) words the titles share: 'Breaking Waves' != 'Breaking Walls'."""
    ka, kb = search_key(a), search_key(b)
    if not ka or not kb:
        return 0.0
    if ka == kb:
        return 1.0
    chars = SequenceMatcher(None, ka, kb).ratio()
    ta = [t for t in ka.split() if t not in STOPWORDS] or ka.split()
    tb = [t for t in kb.split() if t not in STOPWORDS] or kb.split()
    shared = sum(1 for t in ta if any(t == u or SequenceMatcher(None, t, u).ratio() >= 0.8 for u in tb))
    return min(chars, shared / max(len(ta), len(tb)))


def _titles(film: dict) -> list[str]:
    out = []
    orig = film.get("original_title")
    if orig:
        out += [p.strip() for p in re.split(r"\s*/\s*", orig) if p.strip()]
    out.append(latinize(film["title"]))
    seen, uniq = set(), []
    for t in out:
        k = search_key(t)
        if k and k not in seen:
            seen.add(k)
            uniq.append(t)
    return uniq


def _surnames(value: str | None) -> set[str]:
    """Surnames from 'Сем Нил (Sam Neill), Итан Хок (Ethan Hawke)' or 'Павле Вуисић, Драган Николић'."""
    value = value or ""
    latin = re.findall(r"\(([^()]*[A-Za-z][^()]*)\)", value)
    parts = latin or [re.sub(r"\([^()]*\)", "", p) for p in value.split(",")]
    names = set()
    for p in parts:
        words = search_key(latinize(p)).split()
        if words and len(words[-1]) >= 3:
            names.add(words[-1])
    return names


def suggest(query: str) -> list[dict]:
    url = SUGGEST_URL.format(q=urllib.parse.quote(query))
    for attempt in range(3):
        try:
            r = session.get(url, timeout=20)
            if r.status_code == 200:
                time.sleep(0.25)
                return [d for d in r.json().get("d", []) if str(d.get("id", "")).startswith("tt")]
            if r.status_code == 404:
                return []
        except (requests.RequestException, ValueError):
            pass
        time.sleep(2 * (attempt + 1))
    return []


def _evaluate(c: dict, film: dict, titles: list[str], cast: set[str], directors: set[str]):
    bonus = TYPE_BONUS.get(c.get("qid"))
    if bonus is None:
        return None
    label = search_key(c.get("l", ""))
    if any(x in label for x in EXTRAS) and not any(x in search_key(t) for t in titles for x in EXTRAS):
        return None  # "Kingdom of Hope: The Making of 'Kingdom of Heaven'" is not the film
    year, cy = film.get("year"), c.get("y")
    dy = abs(cy - year) if (year and cy) else None
    if dy is not None and dy > 2:
        return None
    year_score = {0: 3.0, 1: 1.5, 2: 0.5}[dy] if dy is not None else (-1.0 if year else 0.0)
    sim = max(title_similarity(c.get("l", ""), t) for t in titles)
    stars = f" {search_key(c.get('s', ''))} "
    cast_hits = sum(1 for n in cast if f" {n} " in stars)
    director_hit = any(f" {n} " in stars for n in directors - cast)  # docs list the director as a "star"
    overlap = cast_hits + director_hit
    score = year_score + 4 * sim + 2.5 * min(cast_hits, 2) + 1.0 * director_hit + bonus
    if year:
        ok = (overlap >= 1 and dy is not None) or (sim >= 0.85 and dy is not None and dy <= 1) \
            or (sim >= 0.6 and dy == 0 and c.get("qid") == "movie")
    else:
        ok = sim >= 0.9 and (overlap >= 1 or c.get("qid") in ("movie", "short"))
    return (score, sim, overlap) if ok else None


def lookup(film: dict) -> dict | None:
    titles = _titles(film)
    cast, directors = _surnames(film.get("cast")), _surnames(film.get("director"))
    year = film.get("year")
    queries = []
    for t in titles:
        q = _query_text(t)
        if q:
            if year:
                queries.append(f"{q} {year}")
            queries.append(q)
    best = None
    tried = set()
    for q in queries:
        if q in tried:
            continue
        tried.add(q)
        for c in suggest(q):
            ev = _evaluate(c, film, titles, cast, directors)
            if ev and (best is None or ev[0] > best[0][0]):
                best = (ev, c)
        if best and (best[0][2] >= 1 or best[0][1] >= 0.9) and best[0][0] >= 6:
            break  # confident enough
    if not best:
        return None
    c = best[1]
    return _entry(c)


def _entry(c: dict) -> dict:
    return {
        "id": c["id"],
        "title": c.get("l"),
        "year": c.get("y"),
        "type": c.get("qid"),
        "poster": poster_url((c.get("i") or {}).get("imageUrl")),
    }


def by_id(imdb_id: str) -> dict | None:
    for c in suggest(imdb_id):
        if c.get("id") == imdb_id:
            return _entry(c)
    return {"id": imdb_id, "title": None, "year": None, "type": None, "poster": None}


class Enricher:
    def __init__(self, cache_path: Path, overrides_path: Path):
        self.cache_path = cache_path
        self.cache = json.loads(cache_path.read_text("utf-8")) if cache_path.exists() else {}
        self.overrides = json.loads(overrides_path.read_text("utf-8")) if overrides_path.exists() else {}
        self.overrides = {k: v for k, v in self.overrides.items() if not k.startswith("_")}
        self.lookups = 0

    def _override(self, film: dict):
        for k in (f"{film['title']} ({film.get('year')})", film["title"], film.get("original_title") or ""):
            if k in self.overrides:
                return True, self.overrides[k]
        return False, None

    def match(self, film: dict) -> dict | None:
        has, forced = self._override(film)
        key = film_key(film)
        cached = self.cache.get(key)
        if has:
            if forced is None:
                return None
            if cached and cached.get("id") == forced:
                return cached
            entry = by_id(forced)
            self.cache[key] = {**entry, "checked": date.today().isoformat(), "override": True}
            return self.cache[key]
        if cached and not cached.get("override"):
            if cached.get("id") or date.fromisoformat(cached["checked"]) > date.today() - timedelta(RETRY_MISSES_AFTER_DAYS):
                return cached if cached.get("id") else None
        self.lookups += 1
        entry = lookup(film)
        self.cache[key] = {**(entry or {"id": None}), "checked": date.today().isoformat()}
        return entry

    def enrich_program(self, program: dict) -> None:
        for day in program["days"]:
            for slot in day["slots"]:
                for film in slot["films"]:
                    entry = self.match(film)
                    old = film.get("imdb") or {}
                    film["imdb"] = None if not entry else {
                        "id": entry["id"], "title": entry.get("title"), "year": entry.get("year"),
                        "poster": entry.get("poster"),
                        "rating": old.get("rating") if old.get("id") == entry["id"] else None,
                        "votes": old.get("votes") if old.get("id") == entry["id"] else None,
                    }

    def save(self) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.cache_path.write_text(json.dumps(self.cache, ensure_ascii=False, indent=1, sort_keys=True) + "\n", "utf-8")


def fetch_ratings(ids: set[str]) -> dict[str, tuple[float, int]]:
    """Stream IMDb's daily ratings dataset and pick the requested title ids."""
    if not ids:
        return {}
    r = session.get(RATINGS_URL, timeout=120)
    r.raise_for_status()
    out = {}
    with gzip.open(io.BytesIO(r.content), "rt", encoding="utf-8") as fh:
        next(fh, None)
        for line in fh:
            tconst, _, rest = line.partition("\t")
            if tconst in ids:
                rating, votes = rest.rstrip("\n").split("\t")
                out[tconst] = (float(rating), int(votes))
    return out


def apply_ratings(program: dict, ratings: dict[str, tuple[float, int]]) -> None:
    for day in program["days"]:
        for slot in day["slots"]:
            for film in slot["films"]:
                imdb = film.get("imdb")
                if imdb and imdb["id"] in ratings:
                    imdb["rating"], imdb["votes"] = ratings[imdb["id"]]


def program_imdb_ids(program: dict) -> set[str]:
    return {f["imdb"]["id"] for d in program["days"] for s in d["slots"] for f in s["films"] if f.get("imdb")}
