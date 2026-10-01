/**
 * Kinoteka – email obaveštenja kad se film pojavi na repertoaru.
 *
 * Podešavanje (jednom, ~5 minuta – detaljno u README.md):
 *   1. Napravi novu Google tabelu (sheets.new) → Extensions → Apps Script.
 *   2. Obriši sadržaj Code.gs, nalepi ovaj fajl, u SITE_URL upiši adresu sajta i sačuvaj (Ctrl/Cmd+S).
 *   3. Izaberi funkciju "setup" i klikni Run → dozvoli pristup (Advanced → Go to … → Allow).
 *   4. Deploy → New deployment → tip "Web app": Execute as: Me, Who has access: Anyone → Deploy.
 *   5. Kopiraj "Web app URL" i upiši ga u site/config.js (notifyUrl).
 *
 * Prijave se čuvaju u listu "Pretplate" ove tabele. Skripta svakog sata čita
 * data/screenings.json sa sajta i šalje email za nove projekcije praćenih filmova.
 */
const SITE_URL = "https://jovanailin.github.io/kinoteka/"; // ← adresa sajta (GitHub Pages)

const SHEET_NAME = "Pretplate";
const TZ = "Europe/Belgrade";
const MAX_PER_EMAIL = 30; // najviše aktivnih prijava po adresi
const MAX_NEW_PER_DAY = 80; // zaštita dnevne kvote Gmail-a (100 emailova/dan)
const HEADERS = ["id", "email", "film", "kljuc", "aktivna", "prijavljeno", "obavesteno_o", "poslednje_obavestenje"];

// ---------------------------------------------------------------- setup / trigger

function setup() {
  getSheet_();
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "checkProgram")
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("checkProgram").timeBased().everyHours(1).create();
  const n = loadScreenings_().length; // proverava i da je SITE_URL ispravan
  Logger.log("Podešeno. Trenutno na repertoaru: " + n + " termina. Provera se pokreće svakog sata.");
}

/** Pokreće se svakog sata: šalje obaveštenja za nove projekcije praćenih filmova. */
function checkProgram() {
  const screenings = loadScreenings_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = getSheet_();
    let quota = MailApp.getRemainingDailyQuota();
    const cutoff = today_();
    for (const r of readRows_(sh)) {
      if (!r.aktivna) continue;
      const done = new Set(parseIds_(r.obavesteno_o));
      const fresh = findMatches_(r.kljuc, screenings).filter((s) => !done.has(s.id));
      if (!fresh.length) continue;
      if (quota <= 0) break; // ostatak stiže kad se kvota obnovi
      sendMail_(r, fresh, false);
      quota--;
      fresh.forEach((s) => done.add(s.id));
      r.obavesteno_o = JSON.stringify([...done].filter((id) => id.slice(0, 10) >= cutoff));
      r.poslednje_obavestenje = new Date();
      writeRow_(sh, r);
    }
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- web app

function doPost(e) {
  rememberUrl_();
  let data;
  try {
    data = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return json_({ ok: false, error: "Neispravan zahtev." });
  }
  if (data.action === "subscribe") {
    try {
      return json_(subscribe_(data));
    } catch (err) {
      console.error(err);
      return json_({ ok: false, error: "Greška na serveru, pokušajte kasnije." });
    }
  }
  return json_({ ok: false, error: "Nepoznata akcija." });
}

function doGet(e) {
  rememberUrl_();
  const p = (e && e.parameter) || {};
  if (p.action === "unsubscribe" && p.id) {
    const row = readRows_(getSheet_()).find((r) => r.id === p.id);
    const film = row ? row.film : "";
    return page_(row && row.aktivna
      ? `<p>Odjava sa obaveštenja za film <b>${esc_(film)}</b>?</p>
         <button id="b" onclick="this.disabled=true;google.script.run.withSuccessHandler(function(m){document.getElementById('out').innerHTML=m;document.getElementById('b').remove();}).confirmUnsubscribe(${JSON.stringify(p.id)})">Da, odjavi me</button>
         <p id="out"></p>`
      : `<p>Ova prijava je već otkazana ili ne postoji.</p>`);
  }
  return page_("<p>Kinoteka obaveštenja rade ✔</p>");
}

/** Poziva se iz stranice za odjavu (dugme), da email skeneri ne bi odjavili korisnika samim otvaranjem linka. */
function confirmUnsubscribe(id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getSheet_();
    const r = readRows_(sh).find((x) => x.id === id);
    if (!r) return "Prijava nije pronađena.";
    r.aktivna = false;
    writeRow_(sh, r);
    return `Odjavljeni ste – više nećete dobijati obaveštenja za <b>${esc_(r.film)}</b>.`;
  } finally {
    lock.releaseLock();
  }
}

function subscribe_(d) {
  if (d.website) return { ok: true, message: "Hvala!" }; // honeypot: popunjavaju ga samo botovi
  const email = String(d.email || "").trim().toLowerCase();
  const film = String(d.film || "").trim().replace(/\s+/g, " ").slice(0, 120);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(email)) return { ok: false, error: "Email adresa nije ispravna." };
  const kljuc = key_(film);
  if (kljuc.length < 2) return { ok: false, error: "Upišite naziv filma." };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getSheet_();
    const rows = readRows_(sh);
    const mine = rows.filter((r) => r.aktivna && r.email === email);
    if (mine.some((r) => r.kljuc === kljuc)) {
      return { ok: true, message: `Već ste prijavljeni za „${film}”.` };
    }
    if (mine.length >= MAX_PER_EMAIL) return { ok: false, error: "Dostignut je maksimalan broj prijava za ovu adresu." };
    const today = today_();
    const newToday = rows.filter((r) => r.prijavljeno && Utilities.formatDate(new Date(r.prijavljeno), TZ, "yyyy-MM-dd") === today).length;
    if (newToday >= MAX_NEW_PER_DAY || MailApp.getRemainingDailyQuota() < 5) {
      return { ok: false, error: "Danas je prijavljeno previše obaveštenja, pokušajte sutra." };
    }

    let hits = [];
    try {
      hits = findMatches_(kljuc, loadScreenings_());
    } catch (err) {
      console.warn(err); // sajt privremeno nedostupan – prijava se ipak čuva
    }
    const row = {
      id: Utilities.getUuid(), email, film, kljuc, aktivna: true, prijavljeno: new Date(),
      obavesteno_o: JSON.stringify(hits.map((s) => s.id)), poslednje_obavestenje: hits.length ? new Date() : "",
    };
    sendMail_(row, hits, true);
    sh.appendRow(HEADERS.map((h) => row[h]));
    return {
      ok: true,
      message: hits.length
        ? `Prijava je sačuvana. Film je već na repertoaru – poslali smo vam termine na ${email}.`
        : `Prijava je sačuvana. Javićemo na ${email} kad se „${film}” pojavi na repertoaru.`,
    };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- matching

function loadScreenings_() {
  const url = SITE_URL.replace(/\/?$/, "/") + "data/screenings.json?t=" + Date.now();
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) throw new Error("Ne mogu da preuzmem " + url + " (HTTP " + res.getResponseCode() + ")");
  return JSON.parse(res.getContentText()).screenings || [];
}

/** Projekcije od danas nadalje u kojima se neki film poklapa sa traženim nazivom. */
function findMatches_(kljuc, screenings) {
  const today = today_();
  return screenings.filter((s) => s.date >= today && s.films.some((f) => filmMatches_(kljuc, f)));
}

/** Film se poklapa po srpskom, originalnom ili IMDb (uglavnom engleskom) naslovu. */
function filmMatches_(kljuc, f) {
  if (!f._keys) f._keys = [f.title, f.original_title, f.imdb_title].filter(Boolean).map(key_);
  return f._keys.some((t) => titleMatch_(kljuc, t));
}

/**
 * Da li traženi naziv q odgovara naslovu t (oba već prošla kroz key_)?
 * Cele reči uvek, početak reči od 4+ slova, a uz to trpi greške u kucanju:
 * 1 greška za nazive od 5–8 slova, 2 za 9–14, 3 za duže; prvo slovo mora da se poklopi.
 */
function titleMatch_(q, t) {
  if (!q || !t) return false;
  const padded = " " + t + " ";
  if (padded.indexOf(" " + q + " ") !== -1) return true;
  if (q.length >= 4 && padded.indexOf(" " + q) !== -1) return true;
  const max = q.length < 5 ? 0 : q.length < 9 ? 1 : q.length < 15 ? 2 : 3;
  return max > 0 && fuzzyDistance_(q, t) <= max;
}

/**
 * Najmanji broj izmena (slovo viška, manjka, pogrešno ili zamena dva susedna) između q i nekog
 * dela naslova t koji počinje na početku reči, istim slovom kao q.
 */
function fuzzyDistance_(q, t) {
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
  return Math.min.apply(null, prev);
}

// ---------------------------------------------------------------- email

function sendMail_(row, hits, isNew) {
  const site = SITE_URL.replace(/\/?$/, "/");
  const unsub = webAppUrl_() + "?action=unsubscribe&id=" + encodeURIComponent(row.id);
  const subject = hits.length
    ? `Kinoteka: „${row.film}” je na repertoaru`
    : `Kinoteka: prijava za „${row.film}”`;
  let html = '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1c1915;max-width:560px">';
  if (hits.length) {
    html += `<p>Film koji pratite – <b>${esc_(row.film)}</b> – je na repertoaru Jugoslovenske kinoteke (Uzun Mirkova 1):</p>`;
    html += '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">';
    for (const s of hits) html += screeningRow_(s, row.kljuc);
    html += "</table>";
  } else if (isNew) {
    html += `<p>Prijavili ste se za obaveštenje o filmu <b>${esc_(row.film)}</b>.</p>
             <p>Čim se pojavi na repertoaru Jugoslovenske kinoteke, stići će vam email sa terminima.</p>`;
  }
  html += `<p><a href="${site}" style="color:#8c6700">Ceo program u kalendaru →</a></p>
           <p style="color:#888;font-size:12px;margin-top:24px">Ne želite više obaveštenja za ovaj film?
           <a href="${unsub}" style="color:#888">Odjavite se</a>.</p></div>`;
  MailApp.sendEmail({ to: row.email, subject: subject, htmlBody: html, name: "Kinoteka repertoar" });
}

function screeningRow_(s, kljuc) {
  const film = s.films.find((f) => filmMatches_(kljuc, f)) || s.films[0];
  const when = longDate_(s.date) + (s.times.length ? " u " + s.times.join(" i ") + (s.end ? "–" + s.end : "") : "");
  const poster = film.poster ? film.poster.replace(/UX\d+_/, "UX120_") : "";
  const meta = [film.original_title, film.year, film.rating ? "IMDb " + film.rating.toFixed(1) : ""].filter(Boolean).join(" · ");
  return `<tr>
    <td style="padding:10px 12px 10px 0;vertical-align:top;width:60px">${poster ? `<img src="${poster}" width="60" style="border-radius:4px;display:block" alt="">` : ""}</td>
    <td style="padding:10px 0;vertical-align:top;border-bottom:1px solid #eee">
      <div style="font-weight:bold">${esc_(when)}</div>
      <div>${esc_(latinize_(film.title))}${s.label ? " – " + esc_(latinize_(s.label)) : ""}</div>
      ${meta ? `<div style="color:#666;font-size:13px">${esc_(meta)}</div>` : ""}
      ${s.section ? `<div style="color:#666;font-size:13px">${esc_(latinize_(s.section))}</div>` : ""}
    </td></tr>`;
}

// ---------------------------------------------------------------- sheet helpers

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readRows_(sh) {
  const values = sh.getDataRange().getValues();
  return values.slice(1).map((v, i) => {
    const r = { _row: i + 2 };
    HEADERS.forEach((h, k) => (r[h] = v[k]));
    r.aktivna = r.aktivna === true || String(r.aktivna).toUpperCase() === "TRUE";
    r.id = String(r.id);
    return r;
  }).filter((r) => r.id);
}

function writeRow_(sh, r) {
  sh.getRange(r._row, 1, 1, HEADERS.length).setValues([HEADERS.map((h) => r[h])]);
}

function parseIds_(s) {
  try {
    return JSON.parse(s || "[]");
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------- misc helpers

function rememberUrl_() {
  try {
    const url = ScriptApp.getService().getUrl();
    if (url && /\/exec$/.test(url)) PropertiesService.getScriptProperties().setProperty("WEB_APP_URL", url);
  } catch (e) { /* ignore */ }
}

function webAppUrl_() {
  return PropertiesService.getScriptProperties().getProperty("WEB_APP_URL") || ScriptApp.getService().getUrl();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function page_(body) {
  return HtmlService.createHtmlOutput(
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;max-width:520px;margin:40px auto;padding:0 16px">
       <h2 style="margin:0 0 16px">Kinoteka · obaveštenja</h2>${body}
       <p style="margin-top:28px"><a href="${SITE_URL}" target="_top">← Program Kinoteke</a></p></div>`
  ).setTitle("Kinoteka obaveštenja");
}

function today_() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
}

const MONTHS_ = ["januar", "februar", "mart", "april", "maj", "jun", "jul", "avgust", "septembar", "oktobar", "novembar", "decembar"];
const WEEKDAYS_ = ["nedelja", "ponedeljak", "utorak", "sreda", "četvrtak", "petak", "subota"];

function longDate_(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS_[wd]}, ${d}. ${MONTHS_[m - 1]}`;
}

function esc_(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Ćirilica → latinica i ključ za poređenje naslova (ista pravila kao na sajtu i u scraper/text.py)
const CYR_ = {
  А: "A", Б: "B", В: "V", Г: "G", Д: "D", Ђ: "Đ", Е: "E", Ж: "Ž", З: "Z", И: "I", Ј: "J", К: "K", Л: "L", Љ: "Lj",
  М: "M", Н: "N", Њ: "Nj", О: "O", П: "P", Р: "R", С: "S", Т: "T", Ћ: "Ć", У: "U", Ф: "F", Х: "H", Ц: "C", Ч: "Č",
  Џ: "Dž", Ш: "Š", Й: "J", Ы: "Y", Э: "E", Ю: "Ju", Я: "Ja", Щ: "Šč", Ъ: "", Ь: "", Ё: "Jo", Є: "Je", І: "I",
  Ї: "Ji", Ґ: "G", Ѓ: "Gj", Ќ: "Kj", Ѕ: "Dz",
};
Object.keys(CYR_).forEach((k) => (CYR_[k.toLowerCase()] = CYR_[k].toLowerCase()));

function latinize_(s) {
  if (!s) return "";
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    let lat = CYR_[ch];
    if (lat === undefined) { out += ch; continue; }
    if (lat.length > 1 && ch !== ch.toLowerCase()) {
      const nxt = s[i + 1] || "", prv = s[i - 1] || "";
      const up = (c) => c && c !== c.toLowerCase();
      if (up(nxt) || (nxt.toLowerCase() === nxt.toUpperCase() && up(prv))) lat = lat.toUpperCase();
    }
    out += lat;
  }
  return out;
}

function key_(s) {
  return latinize_(s || "").replace(/đ/g, "dj").replace(/Đ/g, "Dj").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^0-9a-z]+/g, " ").trim();
}
