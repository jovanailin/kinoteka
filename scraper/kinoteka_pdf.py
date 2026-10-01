"""Parser for the monthly program PDF of the Yugoslav Film Archive (Jugoslovenska kinoteka).

The PDF is exported from Word and has a regular, line-based structure:

    Четвртак, 1. 10.                              <- day header (or a range: "Петак, 9. 10 – недеља, 11. 10.")
    Сећање на... СЕМ НИЛ                          <- section / cycle: free text right before a time line
    16.00 СВЕТ ВАМПИРА (САД, 2009)                <- time + TITLE (countries, year)
    Daybreakers                                   <- original title (optional)
    Улоге: Сем Нил (Sam Neill), ...               <- credits
    Режија: Мајкл Спириг (Michael Spierig), ...
    После пројекције разговор ...                 <- note

A time slot can hold several films (blocks of shorts) or only an event label ("СВЕЧАНО ОТВАРАЊЕ").
"""
import io
import re
from datetime import date

from text import clean_line, fold, mostly_upper, slug

WEEKDAY_NAMES = ["ponedeljak", "utorak", "sreda", "cetvrtak", "petak", "subota", "nedelja"]
WEEKDAYS = "(" + "|".join(WEEKDAY_NAMES) + ")"
DAY_RE = re.compile(
    rf"^{WEEKDAYS}\s*,?\s*(\d{{1,2}})\s*\.\s*(\d{{1,2}})\s*\.?(?:\s*(\d{{4}})\s*\.?)?"
    rf"(?:\s*–\s*(?:{WEEKDAYS}\s*,?\s*)?(\d{{1,2}})\s*\.\s*(\d{{1,2}})\s*\.?(?:\s*(\d{{4}})\s*\.?)?)?$"
)
_T = r"(?:[01]?\d|2[0-3])[.:][0-5]\d(?!\d)"
TIME_RE = re.compile(rf"^(?P<times>{_T}(?:\s*(?:–|,|и|i|&)\s*{_T})*)(?:\s*(?:h|ч|č)\b\.?)?\s*(?P<rest>.*)$")
# "TITLE (САД, 2009)", "TITLE (КИР)", "TITLE (ДАН, 1976) / 1978." (year of the local release)
FILM_RE = re.compile(r"^(?P<title>.*?\S)\s*\((?P<meta>[^()]*)\)\s*(?:/\s*(?P<tail>\d{4}(?:/\d{2,4})?)\.?)?$")
YEAR_RE = re.compile(r"^(?:18|19|20)\d{2}(?:\s*[–/]\s*(?:18|19|20)?\d{2,4})?\.?$")
COUNTRY_RE = re.compile(r"^[^\W\d_]{2,4}(?:\s*/\s*[^\W\d_]{2,4})*$")
COUNTRY_YEAR_RE = re.compile(r"^(?P<c>[^\W\d_]{2,4}(?:\s*/\s*[^\W\d_]{2,4})*)\s+(?P<y>(?:18|19|20)\d{2})\.?$")
CREDIT_RE = re.compile(r"^(?P<label>[^:]{2,40}?)\s*:\s*(?P<value>.+)$")

MONTHS = {
    "januar": 1, "februar": 2, "mart": 3, "april": 4, "maj": 5, "jun": 6, "jul": 7,
    "avgust": 8, "septembar": 9, "oktobar": 10, "novembar": 11, "decembar": 12,
}
CAST = ("uloge", "uloga", "igraju", "glume", "glumci")
DIRECTOR = ("rezij", "rezis", "redite")
OTHER_CREDITS = (
    "scenari", "producen", "produkcij", "muzik", "kamera", "snimatelj", "fotografij", "direktor fotograf",
    "montaz", "glas", "narator", "autor", "animacij", "scenograf", "kostim", "koreograf", "ucestvuj",
    "gost", "moderator", "predava", "tekst", "prema ", "po romanu", "dizajn", "zvuk", "izvod", "uvodn",
    "razgovor vod", "govor", "u razgovoru", "dramaturg", "adaptacij", "specijalni efekti", "crtez",
)
KIND_START = ("kratk", "dugometr", "srednjemetr", "igran", "dokumentar", "animir", "eksperiment", "nemi ",
              "tv film", "tv serij", "omnibus", "muzicki film", "muzicki dokument")
NOTE_WORDS = (
    "projekcij", "razgovor", "premijer", "besplatn", "ulaz", "gost", "posle ", "nakon ", "prisustv",
    "prezentacij", "predavanj", "promocij", "titl", "restaurisan", "kopij", "rezervisan", "otvaranj",
    "zatvaranj", "dodela", "nagrad", "izlozb", "koncert", "uvodn", "prikazuj", "program", "ciklus",
    "festival", "karte", "cena ", "dinara", "rsd", "35 mm", "35mm", "16 mm", "dcp", "uz ",
)
JOINERS = ("и", "i", "uz", "уз", "од", "od", "до", "do", "на", "na", "за", "za", "са", "sa", "у", "u", "and", "&")


def ends_with_joiner(text: str) -> bool:
    words = text.split()
    return bool(words) and words[-1].lower() in JOINERS


def pdf_lines(pdf_bytes: bytes) -> list[str]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(pdf_bytes))
    lines: list[str] = []
    for page in reader.pages:
        lines += [clean_line(l) for l in (page.extract_text() or "").splitlines()]
        lines.append("")
    return lines


def _film_meta(meta: str):
    countries, year, extra = [], None, []
    for p in (p.strip() for p in meta.split(",")):
        if not p:
            continue
        cy = COUNTRY_YEAR_RE.match(p)
        if year is None and YEAR_RE.match(p):
            year = int(p[:4])
        elif not countries and COUNTRY_RE.match(p) and p == p.upper():
            countries = [c.strip() for c in p.split("/") if c.strip()]
        elif cy and not countries and year is None and cy["c"] == cy["c"].upper():
            countries = [c.strip() for c in cy["c"].split("/") if c.strip()]
            year = int(cy["y"])
        else:
            extra.append(p)
    if (not countries and year is None) or any(len(e) > 25 for e in extra):
        return None
    return countries, year, extra


def match_film(text: str):
    m = FILM_RE.match(text)
    if not m:
        return None
    meta = _film_meta(m["meta"])
    if not meta:
        return None
    countries, year, extra = meta
    if m["tail"]:
        extra.append(m["tail"])
    return {"title": m["title"].strip(" –-"), "countries": countries, "year": year, "extra": extra}


def match_time(text: str):
    m = TIME_RE.match(text)
    if not m:
        return None
    raw = m["times"]
    times = [t.replace(".", ":").zfill(5) for t in re.findall(_T, raw)]
    end = None
    if len(times) == 2 and "–" in raw:
        times, end = [times[0]], times[1]
    return {"times": times, "end": end, "rest": m["rest"].strip(" –-")}


def match_credit(text: str):
    m = CREDIT_RE.match(text)
    if not m:
        return None
    label = m["label"].strip()
    key = fold(label)
    if key.startswith(CAST):
        field = "cast"
    elif key.startswith(DIRECTOR):
        field = "director"
    elif key.startswith(OTHER_CREDITS):
        field = "other"
    else:
        return None
    return field, label, m["value"].strip()


def is_kind(text: str) -> bool:
    k = fold(text)
    if len(text.split()) > 6:
        return False
    return k.startswith(KIND_START) or (text[:1].islower() and ("film" in k or "serij" in k))


def looks_like_note(text: str) -> bool:
    k = fold(text)
    return any(w in k for w in NOTE_WORDS)


def is_sectionish(text: str) -> bool:
    return mostly_upper(text) or fold(text).startswith("secanje na")


def join_lines(run: list[str]) -> str:
    out = run[0]
    for prev, nxt in zip(run, run[1:]):
        wrapped = prev.endswith((":", ",", "–", "/")) or ends_with_joiner(prev) or len(prev) >= 60
        out += (" " if wrapped else " – ") + nxt
    return out


def classify(line: str) -> str:
    key = fold(line)
    if DAY_RE.match(key):
        return "day"
    if match_time(line):
        return "time"
    if match_credit(line):
        return "credit"
    info = match_film(line)
    if info and mostly_upper(info["title"]):
        return "film"
    return "text"


def resolve_date(year: int, month: int, day: int, weekday: int | None, after: date | None, line: str,
                 program: dict) -> date:
    """Build the date; fix obvious typos ("Недеља, 9. 7." between Aug 8 and Aug 10) using the weekday name."""
    try:
        d = date(year, month, day)
    except ValueError:
        d = None
    if d is not None and (weekday is None or d.weekday() == weekday):
        return d
    candidates = []
    if after is not None and weekday is not None:
        for dm in (-1, 1, -12, 12):  # neighbouring month, or the same date in a neighbouring year
            y, m = (year, month + dm) if abs(dm) == 1 else (year + dm // 12, month)
            y, m = y + (m - 1) // 12, (m - 1) % 12 + 1
            try:
                c = date(y, m, day)
            except ValueError:
                continue
            if c.weekday() == weekday and 0 < (c - after).days <= 10:
                candidates.append(c)
    if candidates:
        program["warnings"].append(f"Datum ispravljen po danu u nedelji: '{line}' -> {candidates[0].isoformat()}")
        return candidates[0]
    if d is None:
        raise ValueError(f"Neispravan datum: {line}")
    program["warnings"].append(f"Dan u nedelji se ne slaže sa datumom: '{line}'")
    return d


def parse_program(lines: list[str], fallback_year: int | None = None) -> dict:
    lines = [clean_line(l) for l in lines]
    nonempty = [l for l in lines if l]
    title = nonempty[0] if nonempty else ""
    header_key = fold(title)
    ym = re.search(r"(19|20)\d{2}", header_key)
    year = int(ym.group(0)) if ym else (fallback_year or date.today().year)
    header_months = [MONTHS[w] for w in re.findall(r"[a-z]+", header_key) if w in MONTHS]

    program = {"title": title, "venue": None, "intro": [], "days": {}, "warnings": []}
    days = program["days"]
    st = {
        "dates": [], "section": None, "slot": None, "film": None,
        "phase": None,        # "head" right after a film line (original title may follow), "credits" afterwards
        "last_credit": None,  # (dict, key) of the last credit value, for wrapped credit lines
        "prev": "start",      # kind of the previous non-empty line, or "blank"
        "prev_month": None, "year": year, "last_date": None,
    }

    def is_noise(i: int) -> bool:
        line = lines[i]
        return bool(re.fullmatch(r"\d{1,3}", line)) or (line == title and i > 0 and bool(st["dates"]))

    def next_nonempty(i: int):
        for j in range(i + 1, len(lines)):
            if lines[j] and not is_noise(j):
                return j
        return None

    def new_slot(times, end, label=None):
        slot = {"times": times, "end": end, "section": st["section"], "label": label,
                "notes": [], "credits": [], "films": []}
        for d in st["dates"]:
            days[d]["slots"].append(slot)
        st.update(slot=slot, film=None, phase=None, last_credit=None)
        return slot

    def add_film(info):
        film = {
            "title": info["title"], "original_title": None, "countries": info.get("countries", []),
            "year": info.get("year"), "kind": None, "cast": None, "director": None, "credits": [],
            "extra": info.get("extra", []),
        }
        if st["slot"] is None:
            new_slot([], None)
        st["slot"]["films"].append(film)
        st.update(film=film, phase="head", last_credit=None)
        return film

    def day_note(text):
        for d in st["dates"]:
            days[d]["notes"].append(text)

    def descriptive(text):
        film, slot = st["film"], st["slot"]
        if film is not None and not film["kind"] and is_kind(text):
            film["kind"] = text
        elif film is not None and st["phase"] == "head" and not film["original_title"] and not looks_like_note(text):
            film["original_title"] = text
        elif slot is not None:
            slot["notes"].append(text)
        else:
            day_note(text)

    def handle_run(run: list[str], followed_by_time: bool):
        # 1. a credit line that wrapped onto the next line
        while run and st["last_credit"] and st["prev"] == "credit":
            tgt, k = st["last_credit"]
            val = tgt[k] or ""
            if not (val.endswith((",", "–")) or val.count("(") > val.count(")") or run[0][:1].islower()
                    or run[0][:1] == "("):
                break
            tgt[k] = (val + " " + run.pop(0)).strip()
        if not run:
            return
        # 2. section / cycle header right before a time line
        if followed_by_time:
            if st["prev"] in ("blank", "day", "start"):
                k = 0
            else:
                k = next((n for n, l in enumerate(run) if is_sectionish(l)), None)
            if k is not None:
                for l in run[:k]:
                    descriptive(l)
                st.update(section=join_lines(run[k:]), slot=None, film=None, phase=None, last_credit=None)
                return
        # 3. an event label that wrapped onto the next line
        slot = st["slot"]
        if (slot is not None and st["prev"] == "time" and slot["label"] and not slot["films"]
                and mostly_upper(run[0]) and (ends_with_joiner(slot["label"]) or len(slot["label"]) >= 50
                                              or slot["label"].endswith((",", "–", "/")))):
            slot["label"] += " " + run.pop(0)
        for l in run:
            descriptive(l)

    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if not line:
            if st["prev"] != "start":
                st["prev"] = "blank"
            i += 1
            continue
        if is_noise(i):
            i += 1
            continue
        kind = classify(line)

        if kind == "day":
            wd1, d1, m1, y1, wd2, d2, m2, y2 = DAY_RE.match(fold(line)).groups()
            m1 = int(m1)
            pm = st["prev_month"]
            if y1:
                st["year"] = int(y1)
            elif pm is None and header_months and header_months[0] - m1 > 6:  # "ДЕЦЕМБАР 2026" starting in January
                st["year"] += 1
            elif pm is None and header_months and m1 - header_months[0] > 6:  # "ЈАНУАР 2027" starting on Dec 31
                st["year"] -= 1
            elif pm is not None and m1 < pm - 6:
                st["year"] += 1
            start = resolve_date(st["year"], m1, int(d1), WEEKDAY_NAMES.index(wd1), st["last_date"], line, program)
            st["year"] = start.year
            dates = [start.isoformat()]
            st["prev_month"] = start.month
            if d2:
                m2 = int(m2)
                y_end = int(y2) if y2 else start.year + (1 if m2 < start.month else 0)
                end = resolve_date(y_end, m2, int(d2), WEEKDAY_NAMES.index(wd2) if wd2 else None, start, line, program)
                span = (end - start).days
                if 0 < span < 40:
                    dates = [date.fromordinal(start.toordinal() + k).isoformat() for k in range(span + 1)]
                st["prev_month"] = end.month
            st["last_date"] = date.fromisoformat(dates[-1])
            for d in dates:
                days.setdefault(d, {"date": d, "notes": [], "slots": []})
            st.update(dates=dates, section=None, slot=None, film=None, phase=None, last_credit=None, prev="day")
            i += 1
            continue

        if not st["dates"]:  # preamble before the first day
            if line != title:
                if program["venue"] is None:
                    program["venue"] = line
                else:
                    program["intro"].append(line)
            st["prev"] = "text"
            i += 1
            continue

        if kind == "time":
            tm = match_time(line)
            rest = tm["rest"]
            info = match_film(rest) if rest else None
            # long title wrapped onto the next line: "19.00 VERY LONG TITLE /" + "CONTINUED (СРБ, 1911)"
            if rest and not info and i + 1 < n and lines[i + 1] and (len(line) >= 60 or rest.endswith(("/", "–", ","))):
                joined = match_film(rest + " " + lines[i + 1])
                if joined:
                    info = joined
                    i += 1
            new_slot(tm["times"], tm["end"], None if info else (rest or None))
            if info:
                add_film(info)
            st["prev"] = "time"
            i += 1
            continue

        if kind == "credit":
            field, label, value = match_credit(line)
            film, slot = st["film"], st["slot"]
            if film is None and slot is not None and slot["label"] and not slot["films"] and field in ("cast", "director"):
                # "17.00 ПОСЛЕДЊЕ ЛЕТО" without (country, year) but followed by credits: it is a film
                film = add_film({"title": slot["label"]})
                slot["label"] = None
            if film is not None and field in ("cast", "director"):
                film[field] = value if not film[field] else film[field] + ", " + value
                st["last_credit"] = (film, field)
                st["phase"] = "credits"
            elif film is not None or slot is not None:
                target = film if film is not None else slot
                target["credits"].append({"label": label, "value": value})
                st["last_credit"] = (target["credits"][-1], "value")
                if film is not None:
                    st["phase"] = "credits"
            else:
                day_note(line)
            st["prev"] = "credit"
            i += 1
            continue

        if kind == "film":
            add_film(match_film(line))
            st["prev"] = "film"
            i += 1
            continue

        # free text: take the whole run of consecutive text lines
        j = i
        run = []
        while j < n and lines[j] and not is_noise(j) and (j == i or classify(lines[j]) == "text"):
            run.append(lines[j])
            j += 1
        nxt = next_nonempty(j - 1)
        handle_run(run, nxt is not None and classify(lines[nxt]) == "time")
        st["prev"] = "text"
        i = j

    # tidy up: trailing commas in credits, sorted days, per-date slot copies with stable ids
    final_days = []
    for d in sorted(days):
        slots, seen = [], set()
        for k, s in enumerate(days[d]["slots"]):
            for f in s["films"]:
                for fld in ("cast", "director"):
                    if f[fld]:
                        f[fld] = f[fld].rstrip(" ,;")
            first = s["films"][0]["title"] if s["films"] else (s["label"] or "dogadjaj")
            t = s["times"][0].replace(":", "") if s["times"] else f"x{k}"
            s_id = f"{d}-{t}-{slug(first, 32)}"
            while s_id in seen:
                s_id += "-2"
            seen.add(s_id)
            slots.append({"id": s_id, **s})
        final_days.append({**days[d], "slots": slots})
    program["days"] = final_days
    if final_days:
        program["first_date"] = final_days[0]["date"]
        program["last_date"] = final_days[-1]["date"]
    return program
