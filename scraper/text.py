"""Text helpers: Serbian Cyrillic -> Latin transliteration and search keys."""
import re
import unicodedata

_CYR = {
    "А": "A", "Б": "B", "В": "V", "Г": "G", "Д": "D", "Ђ": "Đ", "Е": "E", "Ж": "Ž",
    "З": "Z", "И": "I", "Ј": "J", "К": "K", "Л": "L", "Љ": "Lj", "М": "M", "Н": "N",
    "Њ": "Nj", "О": "O", "П": "P", "Р": "R", "С": "S", "Т": "T", "Ћ": "Ć", "У": "U",
    "Ф": "F", "Х": "H", "Ц": "C", "Ч": "Č", "Џ": "Dž", "Ш": "Š",
    # non-Serbian Cyrillic (Russian, Ukrainian, Macedonian...) that shows up in original titles
    "Й": "J", "Ы": "Y", "Э": "E", "Ю": "Ju", "Я": "Ja", "Щ": "Šč", "Ъ": "", "Ь": "",
    "Ё": "Jo", "Є": "Je", "І": "I", "Ї": "Ji", "Ґ": "G", "Ѓ": "Gj", "Ќ": "Kj", "Ѕ": "Dz",
}
_CYR.update({k.lower(): v.lower() for k, v in list(_CYR.items())})


def latinize(s: str) -> str:
    """Transliterate (Serbian) Cyrillic to Latin. Digraphs are fully upper-cased inside ALL-CAPS words."""
    if not s:
        return s
    out = []
    for i, ch in enumerate(s):
        lat = _CYR.get(ch)
        if lat is None:
            out.append(ch)
            continue
        if len(lat) > 1 and ch.isupper():
            nxt = s[i + 1] if i + 1 < len(s) else ""
            prv = s[i - 1] if i > 0 else ""
            if nxt.isupper() or (not nxt.isalpha() and prv.isupper()):
                lat = lat.upper()
        out.append(lat)
    return "".join(out)


def fold(s: str) -> str:
    """Latinize, lowercase and strip diacritics, keeping punctuation (for structure matching)."""
    s = latinize(s or "").replace("đ", "dj").replace("Đ", "Dj")
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower()


def search_key(s: str) -> str:
    """Script/diacritics/punctuation-insensitive key used for title matching."""
    s = fold(s)
    s = re.sub(r"[^0-9a-z]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def slug(s: str, maxlen: int = 40) -> str:
    return search_key(s).replace(" ", "-")[:maxlen].strip("-")


_LAT2CYR = dict(zip("ABCEHKMOPTXJaceopxyj", "АВСЕНКМОРТХЈасеорхуј"))
_CYR2LAT = {v: k for k, v in _LAT2CYR.items()}


def _fix_word(m: re.Match) -> str:
    w = m.group(0)
    cyr = sum(1 for c in w if "\u0400" <= c <= "\u04ff")
    lat = sum(1 for c in w if c.isalpha() and c.isascii())
    if not cyr or not lat:
        return w
    # convert look-alikes towards the majority script; if that is impossible, try the other way ("Lе" -> "Le")
    for table in ((_LAT2CYR, _CYR2LAT) if cyr >= lat else (_CYR2LAT, _LAT2CYR)):
        fixed = "".join(table.get(c, c) for c in w)
        if not (any("\u0400" <= c <= "\u04ff" for c in fixed) and any(c.isalpha() and c.isascii() for c in fixed)):
            return fixed
    return w


def fix_mixed_script(s: str) -> str:
    """'JУГ' -> 'ЈУГ', 'Еmmanuelle' -> 'Emmanuelle': the PDF sometimes mixes look-alike letters."""
    return re.sub(r"[^\W\d_]+", _fix_word, s)


def clean_line(s: str) -> str:
    s = s.replace(" ", " ").replace("​", "").replace("﻿", "")
    s = re.sub(r"[‐-―−]", "–", s)  # every dash flavour -> en dash
    s = s.replace("’", "'").replace("‘", "'")
    return fix_mixed_script(re.sub(r"\s+", " ", s).strip())


def mostly_upper(s: str) -> bool:
    letters = [c for c in s if c.isalpha()]
    if len(letters) < 3:
        return False
    return sum(c.isupper() for c in letters) / len(letters) >= 0.75
