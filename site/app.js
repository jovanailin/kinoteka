/* Kinoteka · repertoar — kalendar mesečnog programa Jugoslovenske kinoteke.
   Bez build koraka i bez biblioteka: čita JSON koji pravi scraper/update.py. */
(() => {
  "use strict";

  const CFG = window.KINOTEKA_CONFIG || {};
  const TZ = "Europe/Belgrade";
  const VENUE = "Jugoslovenska kinoteka, Uzun Mirkova 1, Beograd";
  const MONTHS = ["januar", "februar", "mart", "april", "maj", "jun", "jul", "avgust", "septembar", "oktobar", "novembar", "decembar"];
  const WEEKDAYS = ["ponedeljak", "utorak", "sreda", "četvrtak", "petak", "subota", "nedelja"];
  const WD_SHORT = ["Pon", "Uto", "Sre", "Čet", "Pet", "Sub", "Ned"];
  const narrow = window.matchMedia("(max-width: 900px)");

  // ---------- text: Cyrillic -> Latin, search keys (same rules as scraper/text.py) ----------
  const CYR = {
    А: "A", Б: "B", В: "V", Г: "G", Д: "D", Ђ: "Đ", Е: "E", Ж: "Ž", З: "Z", И: "I", Ј: "J", К: "K", Л: "L", Љ: "Lj",
    М: "M", Н: "N", Њ: "Nj", О: "O", П: "P", Р: "R", С: "S", Т: "T", Ћ: "Ć", У: "U", Ф: "F", Х: "H", Ц: "C", Ч: "Č",
    Џ: "Dž", Ш: "Š", Й: "J", Ы: "Y", Э: "E", Ю: "Ju", Я: "Ja", Щ: "Šč", Ъ: "", Ь: "", Ё: "Jo", Є: "Je", І: "I",
    Ї: "Ji", Ґ: "G", Ѓ: "Gj", Ќ: "Kj", Ѕ: "Dz",
  };
  for (const [k, v] of Object.entries(CYR)) CYR[k.toLowerCase()] = v.toLowerCase();
  const isUpper = (c) => !!c && c !== c.toLowerCase();
  const isLetter = (c) => !!c && c.toLowerCase() !== c.toUpperCase();

  function latinize(s) {
    if (!s) return "";
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      let lat = CYR[ch];
      if (lat === undefined) { out += ch; continue; }
      if (lat.length > 1 && isUpper(ch)) {
        const nxt = s[i + 1], prv = s[i - 1];
        if (isUpper(nxt) || (!isLetter(nxt) && isUpper(prv))) lat = lat.toUpperCase();
      }
      out += lat;
    }
    return out;
  }
  const fold = (s) => latinize(s || "").replace(/đ/g, "dj").replace(/Đ/g, "Dj").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const key = (s) => fold(s).replace(/[^0-9a-z]+/g, " ").trim();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tx = (s) => (state.script === "lat" ? latinize(s || "") : s || "");
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const filmWord = (n) => {
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return "film";
    return a >= 2 && a <= 4 && (b < 12 || b > 14) ? "filma" : "filmova";
  };

  // ---------- dates ----------
  const todayISO = () => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date());
  const ymd = (iso) => iso.split("-").map(Number);
  const weekday = (iso) => { const [y, m, d] = ymd(iso); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; };
  const daysInMonth = (ym) => { const [y, m] = ymd(ym); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
  const monthTitle = (ym) => { const [y, m] = ymd(ym); return `${cap(MONTHS[m - 1])} ${y}.`; };
  const dayLong = (iso) => { const [, m, d] = ymd(iso); return `${WEEKDAYS[weekday(iso)]}, ${d}. ${MONTHS[m - 1]}`; };
  const dayShort = (iso) => { const [, m, d] = ymd(iso); return `${WD_SHORT[weekday(iso)]} ${d}. ${m}.`; };
  const pad = (n) => String(n).padStart(2, "0");
  function monthsBetween(a, b) {
    const out = [];
    let [y, m] = ymd(a.slice(0, 7));
    const [y2, m2] = ymd(b.slice(0, 7));
    while (y < y2 || (y === y2 && m <= m2)) { out.push(`${y}-${pad(m)}`); m++; if (m > 12) { m = 1; y++; } }
    return out;
  }

  // ---------- state ----------
  const store = {
    get(k) { try { return localStorage.getItem("kinoteka:" + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem("kinoteka:" + k, v); } catch { /* private mode */ } },
  };
  const state = {
    index: null, programs: new Map(), months: [], month: null,
    view: store.get("view") || "grid", script: store.get("script") || "lat",
    query: "", section: null, showPast: false, today: todayISO(),
  };
  const $ = (id) => document.getElementById(id);
  let mergedDaysCache = new Map();

  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  async function ensurePrograms(list) {
    await Promise.all(list.filter((p) => !state.programs.has(p.id)).map(async (p) => {
      state.programs.set(p.id, await getJSON("data/" + p.file));
    }));
  }

  const overlapping = (ym) => state.index.programs.filter((p) => p.first_date <= `${ym}-31` && p.last_date >= `${ym}-01`);

  /** date -> {day, program}; for a date covered by two PDFs the newer program wins */
  function mergedDays() {
    const progs = [...state.programs.values()].sort((a, b) => (a.first_date + a.parsed_at).localeCompare(b.first_date + b.parsed_at));
    const map = new Map();
    for (const p of progs) for (const d of p.days) map.set(d.date, { day: d, program: p });
    return map;
  }

  // ---------- slot helpers ----------
  const slotTime = (s) => (s.times.length ? s.times.join(", ") + (s.end ? `–${s.end}` : "") : "");
  const thumb = (url, w) => (url ? url.replace(/UX\d+_/, `UX${w}_`) : "");
  const firstPoster = (s) => (s.films.find((f) => f.imdb && f.imdb.poster) || {}).imdb?.poster || "";
  const slotTitle = (s) => (s.films.length === 1 ? s.films[0].title : s.label || (s.films[0] && s.films[0].title) || "");

  /** Smallest number of typos (extra/missing/wrong letter, swapped neighbours) between q and a part of t
      that starts at the beginning of a word with the same letter as q. Same as fuzzyDistance_ in Code.gs. */
  function fuzzyDistance(q, t) {
    const n = q.length, m = t.length, INF = 1e6;
    let prev2 = null;
    let prev = new Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j < m && (j === 0 || t[j - 1] === " ") && t[j] === q[0] ? 0 : INF;
    for (let i = 1; i <= n; i++) {
      const cur = new Array(m + 1);
      cur[0] = prev[0] + 1;
      for (let j = 1; j <= m; j++) {
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (q[i - 1] === t[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && q[i - 1] === t[j - 2] && q[i - 2] === t[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
      }
      prev2 = prev;
      prev = cur;
    }
    return Math.min(...prev);
  }

  /** Whole words, a word beginning (4+ letters), or a few typos: 1 for 5–8 letters, 2 for 9–14, 3 for longer. */
  function titleMatch(q, t) {
    if (!q || !t) return false;
    const padded = " " + t + " ";
    if (padded.includes(" " + q + " ")) return true;
    if (q.length >= 4 && padded.includes(" " + q)) return true;
    const max = q.length < 5 ? 0 : q.length < 9 ? 1 : q.length < 15 ? 2 : 3;
    return max > 0 && fuzzyDistance(q, t) <= max;
  }

  /** Serbian, original and IMDb (mostly English) title of a film, normalised. */
  const filmKeys = (f) => f._keys || (f._keys = [f.title, f.original_title, f.imdb && f.imdb.title].filter(Boolean).map(key));
  const filmMatches = (q, f) => filmKeys(f).some((t) => titleMatch(q, t));

  function slotHay(s) {
    if (!s._hay) {
      const parts = [s.label, s.section, ...s.notes];
      for (const f of s.films) parts.push(f.title, f.original_title, f.director, f.cast, f.imdb && f.imdb.title);
      s._hay = " " + key(parts.filter(Boolean).join(" ")) + " ";
    }
    return s._hay;
  }
  function matches(s) {
    if (state.section && s.section !== state.section) return false;
    const q = key(state.query);
    if (!q) return true;
    const hay = slotHay(s);
    return q.split(" ").every((t) => hay.includes(t)) || s.films.some((f) => filmMatches(q, f));
  }

  function ratingBadge(imdb, big) {
    if (!imdb || imdb.rating == null) return "";
    return `<span class="rating" title="IMDb ocena${imdb.votes ? ` (${imdb.votes.toLocaleString("sr-RS")} glasova)` : ""}">${big ? "IMDb " : "★ "}${imdb.rating.toFixed(1)}</span>`;
  }

  function slotCard(s, date, hues, inList) {
    const film = s.films[0];
    const poster = firstPoster(s);
    const isEvent = !s.films.length;
    const hue = s.section != null ? hues.get(s.section) : null;
    const title = slotTitle(s);
    let sub = "";
    if (s.films.length === 1) {
      const bits = film.original_title ? [film.original_title, film.year] : [tx(film.countries.join("/")), film.year];
      const meta = bits.filter(Boolean).join(" · ");
      sub = meta ? `<div class="orig">${esc(meta)}</div>` : "";
    } else if (s.films.length > 1) {
      const n = s.label ? s.films.length : s.films.length - 1;
      sub = `<div class="more">${s.label ? "" : "+"}${n} ${filmWord(n)}</div>`;
    }
    const rating = s.films.length === 1 ? ratingBadge(film.imdb) : "";
    const posterHtml = isEvent ? "" : `<img class="poster" alt="" loading="lazy" decoding="async" ${poster ? `src="${esc(thumb(poster, inList ? 160 : 100))}"` : ""} onerror="this.removeAttribute('src')">`;
    const secLine = inList && s.section ? `<div class="sec-name">${esc(tx(s.section))}</div>` : "";
    return `<button class="slot${isEvent ? " event" : ""}${hue == null ? " no-sec" : ""}" style="${hue != null ? `--h:${hue}` : ""}"
      data-date="${date}" data-id="${esc(s.id)}" title="${esc(tx(title))}">
      ${posterHtml}
      <div class="slot-body">
        <div class="slot-top">${s.times.length ? `<span class="time">${esc(slotTime(s))}</span>` : ""}${rating}</div>
        <div class="title">${esc(tx(title))}</div>
        ${sub}${secLine}
      </div></button>`;
  }

  function dayNotes(day) {
    return (day.notes || []).map((n) => `<div class="day-note">${esc(tx(n))}</div>`).join("");
  }

  const monthDates = (ym) => Array.from({ length: daysInMonth(ym) }, (_, k) => `${ym}-${pad(k + 1)}`);
  const monthEntries = (ym) => monthDates(ym).map((d) => mergedDaysCache.get(d)).filter(Boolean);

  // ---------- rendering ----------
  function sectionHues(entries) {
    const hues = new Map();
    for (const { day } of entries) for (const s of day.slots) {
      if (s.section != null && !hues.has(s.section)) hues.set(s.section, Math.round((hues.size * 137.508 + 42) % 360));
    }
    return hues;
  }

  function render() {
    const ym = state.month;
    $("month-title").textContent = monthTitle(ym);
    const i = state.months.indexOf(ym);
    $("prev").disabled = i <= 0;
    $("next").disabled = i < 0 || i >= state.months.length - 1;
    $("today-btn").hidden = ym === state.today.slice(0, 7) || !state.months.includes(state.today.slice(0, 7));

    const merged = mergedDaysCache;
    const dates = monthDates(ym);
    const entries = monthEntries(ym);
    const hues = sectionHues(entries);
    if (state.section && !hues.has(state.section)) state.section = null;
    renderSections(entries, hues);

    const view = narrow.matches ? "list" : state.view;
    for (const b of document.querySelectorAll("#view-seg button")) b.setAttribute("aria-pressed", String(b.dataset.view === state.view));
    for (const b of document.querySelectorAll("#script-seg button")) b.setAttribute("aria-pressed", String(b.dataset.script === state.script));

    const cal = $("calendar");
    if (!entries.length) {
      cal.className = "calendar empty";
      cal.innerHTML = "Za ovaj mesec još nema programa.";
    } else {
      cal.className = "calendar";
      cal.innerHTML = view === "grid" ? gridHTML(ym, dates, merged, hues) : listHTML(dates, merged, hues);
    }
    applyFilter();
    renderSource(entries);
  }

  function gridHTML(ym, dates, merged, hues) {
    const lead = weekday(dates[0]);
    const cells = WD_SHORT.map((w) => `<div class="dow">${w}</div>`);
    for (let k = 0; k < lead; k++) cells.push(`<div class="day out" aria-hidden="true"></div>`);
    for (const d of dates) {
      const e = merged.get(d);
      const cls = ["day", d < state.today && "past", d === state.today && "today", weekday(d) >= 5 && "weekend"].filter(Boolean).join(" ");
      let body = "";
      if (!e) body = `<div class="nodata">—</div>`;
      else {
        body = dayNotes(e.day) + e.day.slots.map((s) => slotCard(s, d, hues, false)).join("");
        if (!e.day.slots.length && !e.day.notes.length) body = `<div class="nodata">Nema projekcija</div>`;
      }
      cells.push(`<div class="${cls}" data-day="${d}"><div class="day-head"><span class="day-num">${ymd(d)[2]}</span>${d === state.today ? '<span class="today-tag">danas</span>' : ""}</div>${body}</div>`);
    }
    const trail = (7 - ((lead + dates.length) % 7)) % 7;
    for (let k = 0; k < trail; k++) cells.push(`<div class="day out" aria-hidden="true"></div>`);
    return `<div class="grid">${cells.join("")}</div>`;
  }

  function listHTML(dates, merged, hues) {
    const isCurrent = state.month === state.today.slice(0, 7);
    const shown = dates.filter((d) => merged.get(d));
    const hidePast = isCurrent && !state.showPast && !state.query && !state.section;
    const past = hidePast ? shown.filter((d) => d < state.today) : [];
    const rows = shown.filter((d) => !past.includes(d)).map((d) => {
      const { day } = merged.get(d);
      const cls = ["day", d < state.today && "past", d === state.today && "today"].filter(Boolean).join(" ");
      let body = dayNotes(day) + day.slots.map((s) => slotCard(s, d, hues, true)).join("");
      if (!day.slots.length && !day.notes.length) body = `<div class="nodata">Nema projekcija</div>`;
      return `<div class="${cls}" data-day="${d}"><div class="day-head"><span class="day-num">${ymd(d)[2]}.</span>
        <span class="day-wd">${d === state.today ? "danas · " : ""}${dayLong(d).split(",")[0]}</span></div>
        <div class="day-slots">${body}</div></div>`;
    });
    const btn = past.length ? `<button class="show-past" id="show-past">Prikaži ranije dane u mesecu (${past.length})</button>` : "";
    return `<div class="list">${btn}${rows.join("")}</div>`;
  }

  function renderSections(entries, hues) {
    const counts = new Map();
    for (const { day } of entries) for (const s of day.slots) if (s.section != null) counts.set(s.section, (counts.get(s.section) || 0) + 1);
    $("sections").innerHTML = [...hues.entries()].map(([name, h]) =>
      `<button class="chip" style="--h:${h}" data-section="${esc(name)}" aria-pressed="${state.section === name}" title="${esc(tx(name))}">
        <span>${esc(tx(name))}</span><small>${counts.get(name) || 0}</small></button>`).join("");
  }

  function renderSource(entries) {
    const progs = [...new Set(entries.map((e) => e.program))];
    $("source-info").innerHTML = progs.map((p) => {
      const when = p.parsed_at ? new Date(p.parsed_at).toLocaleDateString("sr-Latn-RS", { timeZone: TZ }) : "";
      return `Izvor: <a href="${esc(p.source_pdf)}" target="_blank" rel="noopener">${esc(tx(p.title))} (PDF)</a>${when ? `, preuzeto ${when.replace(/\.$/, "")}` : ""}.`;
    }).join(" ");
  }

  function applyFilter() {
    const active = !!(key(state.query) || state.section);
    for (const el of document.querySelectorAll("#calendar .slot")) {
      const entry = mergedDaysCache.get(el.dataset.date);
      const s = entry && entry.day.slots.find((x) => x.id === el.dataset.id);
      const ok = !s || matches(s);
      el.classList.toggle("dim", active && !ok);
      el.classList.toggle("hit", !!key(state.query) && ok);
    }
  }
  // ---------- search results across all loaded programs ----------
  function renderSearchResults() {
    const box = $("search-results");
    const q = key(state.query);
    if (!q) { box.hidden = true; box.innerHTML = ""; return; }
    const res = [];
    for (const [d, { day }] of mergedDaysCache) for (const s of day.slots) if (matches(s)) res.push({ d, s });
    res.sort((a, b) => (a.d < state.today) - (b.d < state.today) || a.d.localeCompare(b.d) || (a.s.times[0] || "").localeCompare(b.s.times[0] || ""));
    box.innerHTML = res.length
      ? res.slice(0, 40).map(({ d, s }) => `<button class="res${d < state.today ? " past" : ""}" data-date="${d}" data-id="${esc(s.id)}">
          <span class="res-when">${dayShort(d)}<br>${esc(slotTime(s))}</span>
          <span><span class="res-title">${esc(tx(slotTitle(s)))}</span>${s.films[0] && s.films[0].original_title ? `<br><small>${esc(s.films[0].original_title)}</small>` : ""}</span>
        </button>`).join("")
      : `<div class="empty">Nema projekcija za „${esc(state.query)}” u učitanom programu.</div>`;
    box.hidden = false;
  }

  // ---------- details modal ----------
  function gcalUrl(s, date) {
    if (!s.times.length) return "";
    const [h, m] = s.times[0].split(":").map(Number);
    let endH = h + 2, endM = m;
    if (s.end) [endH, endM] = s.end.split(":").map(Number);
    if (endH > 23) { endH = 23; endM = 59; }
    const d = date.replace(/-/g, "");
    const title = s.films.length === 1 ? latinize(s.films[0].title) : latinize(slotTitle(s));
    const details = [s.section && latinize(s.section), ...s.films.map((f) => [latinize(f.title), f.original_title, f.year].filter(Boolean).join(" · ")), location.href.split("#")[0]].filter(Boolean).join("\n");
    const p = new URLSearchParams({
      action: "TEMPLATE", text: `Kinoteka: ${title}`, dates: `${d}T${pad(h)}${pad(m)}00/${d}T${pad(endH)}${pad(endM)}00`,
      ctz: TZ, location: VENUE, details,
    });
    return "https://calendar.google.com/calendar/render?" + p.toString();
  }

  /** "Роберт де Ниро (Robert de Niro)" -> "Robert de Niro" when the transcription equals the original */
  const people = (v) => tx(v).replace(/([^,()]+?)\s*\(([^()]+)\)/g, (m, a, b) => (key(a) === key(b) ? b : m));

  function filmHTML(f) {
    const im = f.imdb;
    const meta = [f.countries.length && tx(f.countries.join(" / ")), f.year, f.kind && tx(f.kind), ...(f.extra || [])].filter(Boolean).join(" · ");
    const credits = [["Režija", f.director], ["Uloge", f.cast], ...(f.credits || []).map((c) => [c.label, c.value])].filter((c) => c[1]);
    const imdbDiffers = im && im.title && key(im.title) !== key(f.original_title || "") && key(im.title) !== key(f.title);
    return `<article class="m-film">
      <div>${im && im.poster ? `<a href="https://www.imdb.com/title/${esc(im.id)}/" target="_blank" rel="noopener"><img class="poster" alt="Poster: ${esc(im.title || "")}" src="${esc(thumb(im.poster, 400))}"></a>` : `<div class="poster" role="img" aria-label="Nema postera"></div>`}</div>
      <div>
        <h3 class="m-title">${esc(tx(f.title))}</h3>
        ${f.original_title ? `<div class="m-orig">${esc(f.original_title)}</div>` : ""}
        ${meta ? `<div class="m-meta">${esc(meta)}</div>` : ""}
        ${im ? `<div class="m-imdb">${ratingBadge(im, true)}
          ${im.votes ? `<small>${im.votes.toLocaleString("sr-RS")} glasova</small>` : ""}
          <a href="https://www.imdb.com/title/${esc(im.id)}/" target="_blank" rel="noopener">IMDb stranica${imdbDiffers ? `: ${esc(im.title)}${im.year ? ` (${im.year})` : ""}` : ""} ↗</a></div>`
          : `<div class="m-imdb"><small>Nije pronađen na IMDb-u.</small> <a href="https://www.imdb.com/find/?q=${encodeURIComponent(f.original_title || latinize(f.title))}" target="_blank" rel="noopener">Traži na IMDb-u ↗</a></div>`}
        ${credits.length ? `<dl class="m-credits">${credits.map(([l, v]) => `<dt>${esc(tx(l))}</dt><dd>${esc(people(v))}</dd>`).join("")}</dl>` : ""}
      </div></article>`;
  }

  function openSlot(date, id) {
    const entry = mergedDaysCache.get(date);
    const s = entry && entry.day.slots.find((x) => x.id === id);
    if (!s) return;
    const hues = sectionHues(monthEntries(date.slice(0, 7)));
    const sec = s.section ? `<div class="m-sec"><span class="chip" style="--h:${hues.get(s.section) ?? 40}"><span>${esc(tx(s.section))}</span></span></div>` : "";
    const notes = s.notes.length || s.credits.length
      ? `<div class="m-notes">${s.notes.map((n) => `<p>${esc(tx(n))}</p>`).join("")}${s.credits.map((c) => `<p>${esc(tx(c.label))}: ${esc(tx(c.value))}</p>`).join("")}</div>` : "";
    const g = gcalUrl(s, date);
    $("modal-body").innerHTML = `
      <header class="m-head">
        <div class="m-when" id="modal-title">${esc(dayLong(date))}${s.times.length ? ` · <span class="time">${esc(slotTime(s))}</span>` : ""}</div>
        ${sec}
        ${s.label ? `<h2 class="m-label">${esc(tx(s.label))}</h2>` : ""}
        ${notes}
      </header>
      ${s.films.map(filmHTML).join("")}
      <footer class="m-actions">
        ${g ? `<a class="btn" href="${esc(g)}" target="_blank" rel="noopener">Dodaj u Google Calendar</a>` : ""}
        <a class="btn ghost" href="${esc(entry.program.source_pdf)}" target="_blank" rel="noopener">PDF programa</a>
      </footer>`;
    const dlg = $("modal");
    if (!dlg.open) dlg.showModal();
    dlg.scrollTop = 0;
    history.replaceState(null, "", `#${date.slice(0, 7)}/${id}`);
  }

  /** "#2026-10" -> {month}, "#2026-10/2026-10-23-2100-taksista" -> {month, date, id} */
  function parseHash() {
    const [month, id] = decodeURIComponent(location.hash.slice(1)).split("/");
    return { month: /^\d{4}-\d{2}$/.test(month) ? month : null, id: id || null, date: id ? id.slice(0, 10) : null };
  }

  // ---------- notifications ----------
  function upcomingMatches(film) {
    const q = key(film);
    if (q.length < 2) return [];
    const out = [];
    for (const [d, { day }] of mergedDaysCache) {
      if (d < state.today) continue;
      for (const s of day.slots) {
        if (s.films.some((f) => filmMatches(q, f))) out.push({ d, s });
      }
    }
    return out.sort((a, b) => a.d.localeCompare(b.d));
  }

  async function onSubscribe(ev) {
    ev.preventDefault();
    const form = ev.target;
    const msg = $("notify-msg");
    const email = form.email.value.trim();
    const film = form.film.value.trim();
    const already = upcomingMatches(film);
    const alreadyHtml = already.length
      ? `<br>Već je na repertoaru:<ul>${already.slice(0, 5).map(({ d, s }) => `<li>${esc(dayShort(d))} u ${esc(slotTime(s))} – ${esc(tx(slotTitle(s)))}</li>`).join("")}</ul>` : "";
    msg.className = "notify-msg";
    if (!CFG.notifyUrl) {
      msg.classList.add("err");
      msg.innerHTML = "Obaveštenja još nisu podešena (u config.js nedostaje notifyUrl – vidi README)." + alreadyHtml;
      return;
    }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    msg.textContent = "Šaljem…";
    try {
      const r = await fetch(CFG.notifyUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, // "simple" request: no CORS preflight
        body: JSON.stringify({ action: "subscribe", email, film, website: form.website.value }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Greška");
      msg.classList.add("ok");
      msg.innerHTML = `${esc(data.message || "Prijava je sačuvana.")}${alreadyHtml}`;
      form.film.value = "";
    } catch (e) {
      msg.classList.add("err");
      msg.textContent = "Prijava nije uspela: " + (e && e.message ? e.message : "pokušajte ponovo.");
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- navigation ----------
  async function goto(ym, push = true) {
    if (!state.months.includes(ym)) return;
    state.month = ym;
    state.showPast = false;
    await ensurePrograms(overlapping(ym));
    mergedDaysCache = mergedDays();
    if (push) history.replaceState(null, "", "#" + ym);
    render();
  }

  function initialMonth() {
    const fromHash = parseHash().month;
    if (state.months.includes(fromHash)) return fromHash;
    const cur = state.today.slice(0, 7);
    if (state.months.includes(cur)) return cur;
    return state.months.find((m) => m > cur) || state.months[state.months.length - 1];
  }

  function scrollToToday() {
    const el = document.querySelector(`.day[data-day="${state.today}"]`);
    if (el && (narrow.matches || state.view === "list")) el.scrollIntoView({ block: "start" });
  }

  function bind() {
    $("prev").onclick = () => goto(state.months[state.months.indexOf(state.month) - 1]);
    $("next").onclick = () => goto(state.months[state.months.indexOf(state.month) + 1]);
    $("today-btn").onclick = async () => { await goto(state.today.slice(0, 7)); scrollToToday(); };
    $("view-seg").onclick = (e) => {
      const v = e.target.closest("button")?.dataset.view;
      if (v) { state.view = v; store.set("view", v); render(); }
    };
    $("script-seg").onclick = (e) => {
      const v = e.target.closest("button")?.dataset.script;
      if (v) { state.script = v; store.set("script", v); render(); renderSearchResults(); }
    };
    $("sections").onclick = (e) => {
      const b = e.target.closest(".chip");
      if (!b) return;
      state.section = state.section === b.dataset.section ? null : b.dataset.section;
      render();
    };
    let t;
    $("search").oninput = (e) => {
      clearTimeout(t);
      t = setTimeout(() => { state.query = e.target.value; applyFilter(); renderSearchResults(); }, 120);
    };
    $("search").onkeydown = (e) => { if (e.key === "Escape") { e.target.value = ""; state.query = ""; applyFilter(); renderSearchResults(); } };
    document.addEventListener("click", (e) => {
      const slot = e.target.closest(".slot, .res");
      if (slot) {
        const { date, id } = slot.dataset;
        if (slot.classList.contains("res")) {
          $("search-results").hidden = true;
          goto(date.slice(0, 7)).then(() => openSlot(date, id));
        } else openSlot(date, id);
        return;
      }
      if (e.target.id === "show-past") { state.showPast = true; render(); return; }
      if (!e.target.closest(".search")) $("search-results").hidden = true;
    });
    $("search").onfocus = () => { if (key(state.query)) $("search-results").hidden = false; };
    $("modal-close").onclick = () => $("modal").close();
    $("modal").addEventListener("close", () => history.replaceState(null, "", "#" + state.month));
    $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) $("modal").close(); });
    $("notify-form").addEventListener("submit", onSubscribe);
    narrow.addEventListener("change", render);
    window.addEventListener("hashchange", async () => {
      const h = parseHash();
      if (h.month && h.month !== state.month) await goto(h.month, false);
      if (h.id) openSlot(h.date, h.id);
    });
    if (narrow.matches) $("notify").open = false;
  }

  async function init() {
    bind();
    try {
      state.index = await getJSON("data/index.json");
    } catch (e) {
      $("month-title").textContent = "Program";
      $("calendar").className = "calendar empty";
      $("calendar").textContent = "Program još nije preuzet. Pokreni GitHub Action „Ažuriranje programa” (vidi README).";
      return;
    }
    const months = new Set();
    for (const p of state.index.programs) for (const m of monthsBetween(p.first_date, p.last_date)) months.add(m);
    state.months = [...months].sort();
    // current and upcoming programs are loaded up front so search covers everything that is still to come
    const cutoff = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10);
    await ensurePrograms(state.index.programs.filter((p) => p.last_date >= cutoff));
    const h = parseHash();
    await goto(initialMonth(), !h.id);
    if (h.id && h.month === state.month) openSlot(h.date, h.id);
  }

  init();
})();
