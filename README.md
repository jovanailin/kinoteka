# Kinoteka · repertoar

Pregledniji prikaz [mesečnog programa Jugoslovenske kinoteke](https://www.kinoteka.org.rs/repertoar-programi/):
kalendar (ponedeljak je prvi dan), IMDb posteri i ocene, pretraga, latinica/ćirilica,
i email obaveštenje kad se traženi film pojavi na repertoaru.

Sve je besplatno i ne traži server ni API ključeve:

| Deo | Gde radi | Šta radi |
|---|---|---|
| `site/` | GitHub Pages | statična stranica (HTML/CSS/JS, bez build koraka) |
| `scraper/` | GitHub Actions, svaka 3 sata | nalazi dugme „МЕСЕЧНИ ПРОГРАМ”, preuzima PDF, parsira ga, dodaje IMDb podatke i upisuje `site/data/*.json` |
| `apps-script/Code.gs` | Google Apps Script (tvoj Google nalog) | čuva prijave za obaveštenja u Google tabeli i jednom na sat šalje emailove |

Kad Kinoteka objavi novi PDF (ili ispravi postojeći), stranica se sama osveži u roku od ~3 sata.
Stari meseci ostaju u arhivi (strelice pored naziva meseca).

---

## Postavljanje (jednom, ~10 minuta)

### 1. GitHub repozitorijum i GitHub Pages

1. Na <https://github.com/new> napravi **javni** repozitorijum `kinoteka` (bez README-a).
2. U repozitorijumu: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Pošalji kod (iz ovog foldera):
   ```sh
   git init -b main
   git add -A
   git commit -m "Kinoteka repertoar"
   git remote add origin https://github.com/jovanailin/kinoteka.git
   git push -u origin main
   ```
4. Na kartici **Actions** pokrenuće se „Ažuriranje programa”. Kad se završi (zeleno), sajt je na
   **<https://jovanailin.github.io/kinoteka/>**.

> Ako repozitorijum nazoveš drugačije, adresa sajta je `https://<korisnik>.github.io/<ime-repozitorijuma>/`
> – tu adresu upiši i u `SITE_URL` u koraku 2.

### 2. Email obaveštenja (Google Apps Script)

1. Otvori <https://sheets.new> (nova Google tabela), nazovi je npr. „Kinoteka obaveštenja”.
2. **Extensions → Apps Script**. Obriši sadržaj `Code.gs` i nalepi ceo [`apps-script/Code.gs`](apps-script/Code.gs).
3. Proveri da je `SITE_URL` na vrhu fajla adresa tvog sajta, pa sačuvaj (Cmd+S).
4. U padajućem meniju izaberi funkciju **`setup`** → **Run** → odobri pristup
   (Google upozorava jer je skripta tvoja i neproverena: *Advanced → Go to … (unsafe) → Allow*).
   `setup` napravi list „Pretplate” i zakaže proveru svakog sata.
5. **Deploy → New deployment** → ⚙ **Web app** → *Execute as:* **Me**, *Who has access:* **Anyone** → **Deploy**.
6. Kopiraj **Web app URL** (završava se sa `/exec`) i upiši ga u [`site/config.js`](site/config.js):
   ```js
   window.KINOTEKA_CONFIG = { notifyUrl: "https://script.google.com/macros/s/…/exec" };
   ```
   pa `git commit -am "Obaveštenja" && git push` – sajt se ponovo objavi za minut-dva.

Emailovi stižu sa tvoje Gmail adrese (pošiljalac „Kinoteka repertoar”). Gmail dozvoljava ~100 poslatih
emailova dnevno, što je za ovu namenu dovoljno. Svaki email ima link za odjavu; sve prijave vidiš (i možeš
da menjaš) u Google tabeli.

> Ako kasnije menjaš `Code.gs`: **Deploy → Manage deployments → ✎ → Version: New version → Deploy**
> (URL ostaje isti). Satna provera uvek koristi poslednju sačuvanu verziju.

---

## Kako radi

- **Parser** (`scraper/kinoteka_pdf.py`) čita PDF red po red: dan („Четвртак, 1. 10.” ili raspon dana),
  ciklus (tekst neposredno iznad termina), termin (`16.00 НАСЛОВ (ЗЕМЉА, ГОДИНА)`), originalni naslov,
  uloge/režija i napomene. Ume da spoji prelomljene redove, blokove kratkih filmova u istom terminu
  i da ispravi očiglednu grešku u datumu pomoću dana u nedelji (npr. „Недеља, 9. 7.” umesto 9. 8.).
- **IMDb** (`scraper/imdb.py`): pretraga preko javnog IMDb autocomplete-a (originalni naslov + godina),
  a kandidat se bira po godini, sličnosti naslova i poklapanju glumaca iz PDF-a. Ocene dolaze iz zvaničnog
  IMDb dataseta (osvežava se jednom nedeljno). Pronađe ~90% filmova; studentskih i festivalskih kratkih
  filmova često nema na IMDb-u.
- **Pogrešno IMDb poklapanje?** Dodaj red u [`scraper/imdb_overrides.json`](scraper/imdb_overrides.json):
  `"НАСЛОВ ИЗ PDF-а": "tt1234567"` (ili `null` da film ostane bez IMDb podataka), pa push.
- **Obaveštenja** se poklapaju po srpskom, originalnom ili IMDb (uglavnom engleskom) naslovu, bez obzira
  na pismo i dijakritike („taksista”, „Таксиста” i „Taxi Driver” nalaze isti film), i trpe greške u kucanju:
  1 za nazive od 5–8 slova, 2 za 9–14, 3 za duže („taksita”, „to kill a mokingbird”). Kratki nazivi
  (do 4 slova) moraju biti tačni, a prvo slovo mora da se poklopi – da „Majka” ne bi javila „Hajku”.
  Za svaku projekciju stiže najviše jedan email; prijava važi dok se ne odjaviš.

## Održavanje

Praktično ništa. Ako Kinoteka promeni format PDF-a toliko da parser ne prepozna program, GitHub
Action se završi greškom i GitHub ti pošalje email – sajt u međuvremenu prikazuje poslednji ispravan program.

Ručno pokretanje: **Actions → Ažuriranje programa → Run workflow**.

Lokalno:
```sh
python3 -m venv .venv && .venv/bin/pip install -r scraper/requirements.txt
.venv/bin/python scraper/update.py                 # isto što radi GitHub Action
.venv/bin/python scraper/update.py --pdf URL.pdf   # uvoz konkretnog (npr. starijeg) PDF-a
python3 -m http.server -d site 8000                # pregled na http://localhost:8000
```

Podaci: program © Jugoslovenska kinoteka; posteri i ocene © IMDb, koriste se za ličnu i nekomercijalnu upotrebu.
Ovo je nezvaničan prikaz i nije povezan sa Jugoslovenskom kinotekom.
