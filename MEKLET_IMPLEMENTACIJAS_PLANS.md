# Īpašumu, Sludinājumu un Darījumu Meklētāja (`/meklet`) Implementācijas Plāns

> **Mērķis:** Izveidot modernu, zibenīgu un visaptverošu nekustamā īpašuma meklēšanas un analītikas dzinēju `/meklet` (paraugs: `https://kadastrakarte.lv/meklet`), kas apvieno visus 4 datu slāņus: **Sludinājumus**, **Zemesgrāmatas darījumus**, **Kadastra īpašumus** un **Izsoles** ar elastīgiem filtriem, tabulas sarakstu un split-screen sinhronizēto karti.

---

## 1. Sistēmas Arhitektūra un Funkcionālais Pārskats

Sadaļa `/meklet` nodrošina vienotu saskarni ar 4 galvenajiem darba režīmiem:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  REŽĪMU JOSLA: [ Sludinājumi (21k) ] [ Darījumi (197k) ] [ Īpašumi (2.5M) ] [ Izsoles (590) ]  🟢 Dzīvie dati │
├──────────────────────────────────────────────────────────────────────────────────┤
│  FILTRU JOSLA: Vieta (Rīga...) | Pārdod/Īrē | Dzīvokļi | Cena | Platība | Istabas | Cenas kritums │
├──────────────────────────────────────────────────────────────────────────────────┤
│  KONTROLES: Atrasti: 1,420 | [Aktīvie] [Arhīvs] | Kārtot: Jaunākie ▼ | [🗺️ Karte] [☑ Seko kartei] │
├───────────────────────────────────────────────────────┬──────────────────────────┤
│  REZULTĀTU TABULA (Paginācija 25/50/100)              │  SINHRONIZĒTĀ KARTE     │
│  • [Foto] Dzelzavas 40 | 65 000 € (-8%) | 54m² | 2 ist.│  (Split-screen režīms,   │
│  • [Foto] Brīvības 100 | 120 000 €      | 78m² | 3 ist.│  kur punkti atbilst      │
│  • [Foto] Miera 15     | 85 000 € (-5%) | 62m² | 2 ist.│  atlasītajiem filtriem)  │
└───────────────────────────────────────────────────────┴──────────────────────────┘
```

---

## 2. Datu Struktūra un 4 Darba Režīmi

| Režīms | Primārais Avots | Mūsu Tabula PostGIS | Galvenie Attēlojamie Lauki |
| :--- | :--- | :--- | :--- |
| **1. `listings`** (Sludinājumi) | Multi-source skreiperi (`ss.com`, `city24.lv`, `pp.lv`) | `public.listings`, `public.listing_price_changes` | Foto, adrese, cena, €/m², platība, istabas, stāvs, sērija, cenu krituma %, dienas tirgū, portāls, datums. |
| **2. `deals`** (Darījumi) | VZD Nekustamā īpašuma tirgus bāze (NĪTB) | `public.transactions`, `public.parcels` | Datums, summa, €/m², objekta tips (dzīvoklis, zeme, māja), platība, istabas, adrese, kadastra kods. |
| **3. `props`** (Īpašumi) | VZD Kadastra atvērtie dati (1.05M zemes, 1.47M ēku) | `public.parcels`, `public.buildings` | Kadastra kods, adrese, lietošanas veids, būvniecības gads, stāvi, platība, kadastrālā vērtība, telpu skaits. |
| **4. `auctions`** (Izsoles) | Tiesu izpildītāju & TA izsoles (`izsoles.ta.gov.lv`) | `public.listings WHERE deal_type='auction'` | Sākumcena, pašreizējā likme, novērtējums, izsoles posms, beigu termiņš, adrese, kadastrs, foto. |

---

## 3. Izstrādes Soļi (Roadmap)

### 📌 1. Posms: Go API Dzinējs (`api/main.go`)

Izveidot divus jaunus, augstas veiktspējas REST API galapunktus:

#### 1.1. Kopskaitu un dzīvās bāzes endpoints: `GET /api/meklet-stats`
* Atgriež visu 4 kategoriju dzīvos skaitītājus no PostGIS:
  ```json
  {
    "listings": 21486,
    "deals": 197199,
    "props": 2527961,
    "auctions": 592,
    "updated_at": "2026-10-28T22:50:00Z"
  }
  ```
* Atmiņas kešošana uz 5 minūtēm ar fona atjaunošanu.

#### 1.2. Vienotais meklēšanas un filtrēšanas endpoints: `GET /api/search`
* **Pieņemamie parametri:**
  * `mode`: `listings` (noklusējums), `deals`, `props`, `auctions`
  * `q`: brīvā teksta meklēšana (adrese, iela, kadastra kods, apraksts)
  * `town`, `district`: pilsēta / novads / apkaime (Rīga, Jūrmala, Centrs, Purvciems utt.)
  * `deal`: `sell` | `rent` | `all`
  * `cat`: `flats` | `houses` | `land` | `commercial`
  * `pmin`, `pmax`: cenas diapazons
  * `amin`, `amax`: platības diapazons
  * `rmin`, `rmax`: istabu skaits
  * `fmin`, `fmax`: stāvs
  * `series`: ēkas sērija (103, 119, Pirmskara, Jaunais, Hruščova utt.)
  * `drop`: tikai sludinājumi ar cenas samazinājumu (`delta_amount < 0`)
  * `portal`: filtrs pēc avota (`ss.com`, `city24.lv`, `all`)
  * `active`: `1` (tikai aktīvie, noklusējums), `0` (arhīvs)
  * `sort`: `seen` (jaunākie), `price_asc`, `price_desc`, `ppm_asc`, `ppm_desc`, `drop_pct` (lielākā atlaide), `area`
  * `page`, `per`: paginācija (noklusējums: `page=1`, `per=50`)
  * `bbox`: telpiskais filtrs (`minLng,minLat,maxLng,maxLat`) kartei "Seko kartei" režīmā.
* **Atbilde:**
  ```json
  {
    "mode": "listings",
    "total": 1420,
    "page": 1,
    "per": 50,
    "sort": "seen",
    "dir": "DESC",
    "rows": [ ... ]
  }
  ```
* **Optimizācija:** Paginēti SQL vaicājumi ar `LIMIT` un `OFFSET`, izmantojot jau izveidotos B-tree un GIST telpiskos indeksus.

---

### 📌 2. Posms: Frontend Maršrutēšana un URL Sinhronizācija

Izveidot modernu lietotāja saskarni ar pilnu stāvokļa sinhronizāciju:

#### 2.1. Maršruts `/meklet`
* Pievienot maršrutētājā atsevišķu skatu: `/meklet` (kā arī navigācijas saiti galvenajā izvēlnē "Meklētājs / Sludinājumi & Darījumi").
* Atbalstīt skaistās saites un URL stāvokļa saglabāšanu:
  * `/meklet?mode=listings&deal=sell&cat=flats&town=Rīga&pmax=100000`
  * Lietotājs var nokopēt saiti un nosūtīt kolēģim, un atvērsies precīzi tie paši filtri.
* Saglabāt lietotāja pēdējos izvēlētos filtrus `localStorage` (`kartes_search_state`).

#### 2.2. Viedā apkaimju un adrešu ievade
* Integrēt `/api/address-suggest` ātro autocomplete lauku:
  * Ievadot *"Dzelz"*, uzreiz piedāvā: *"Dzelzavas iela, Rīga"*, *"Dzelzceļa iela, Jūrmala"*, kā arī apkaimes (*"Purvciems"*, *"Teika"*).

---

### 📌 3. Posms: UI Komponentes un Dizaina Sistēma

Izmantojot mūsu esošo moderno dizaina sistēmu (`Inter / Hanken Grotesk`, stikla efekti, tumšā/gaišā tēma):

#### 3.1. Režīmu pārslēdzējs (Mode Switcher)
* Četras interaktīvas pogas ar ikonām un skaitītājiem:
  * **Sludinājumi** *(21.4k)*
  * **Darījumi** *(197.1k)*
  * **Īpašumi** *(2.5M)*
  * **Izsoles** *(592)*
* Zaļais pulsējošais indikators: `🟢 Dzīvie dati`.

#### 3.2. Dinamiskā filtru josla
* Pielāgojas atkarībā no izvēlētā režīma:
  * Sludinājumos: darījuma tips, istabas, cenas kritums, sērijas, portāls.
  * Darījumos: datumu diapazons (2020–2026), darījuma summa, m² cena, objekta veids.
  * Īpašumos: lietošanas veids (dzīvojamā, komerc, ražošana), stāvu skaits, ekspluatācijas gads, kadastrālā vērtība.
  * Izsolēs: izsoles posms (1., 2.), beigu termiņš, nodrošinājuma summa.

#### 3.3. Rezultātu tabula
* Pārskatāma, adaptīva datu tabula:
  * **Foto miniatūra** (ar skaitu, piemēram `📷 12`).
  * **Objekts & Adrese**: adrese ar klikšķināmu saiti uz pilno īpašuma atskaiti.
  * **Cena**: izcelta cena EUR ar aprēķinātu €/m².
  * **Cenas dinamika**: ja bijusi atlaide, rāda zaļu/sarkanu atzīmi: `📉 -12.5%` vai `-8 000 €`.
  * **Parametri**: istabas, platība m², stāvs, sērija.
  * **Dienas tirgū**: `42 d.` (ar krāsu indikāciju: jauns < 7d, vidējs, ilgstošs).
  * **Avots**: mazas birkas `ss.com`, `city24`, `izsoles`.

#### 3.4. Split-Screen integrācija ar Karti
* Poga **"Karte"** pārslēdz skatu uz dalītu ekrānu (50% tabula / 50% interaktīvā karte).
* Izvēles rūtiņa **"Seko kartei" (`mapfollow`)**:
  * Kad lietotājs pavelk vai pietuvina karti, saraksts tabulā sekundes desmitdaļā pārrēķinās un rāda tikai tos objektus, kas atrodas redzamajā apgabalā.
* Uzklikšķinot uz rindiņas tabulā, karte automātiski aizlido (`flyTo`) uz attiecīgo īpašumu un atver tā punktu.

---

### 📌 4. Posms: Dziļā Modālo Logu Integrācija

Savienot tabulas klikšķus ar mūsu esošajiem analītikas logiem:
1. **Sludinājuma modāls**:
   * Attēlu galerija, pilns apraksts, cenu izmaiņu grafiks, poga "Atvērt portālā ↗" un poga "Skatīt ēkas kadastra atskaiti ➔".
2. **Īpašuma atskaites modāls**:
   * Zemes vienības un ēkas kadastra profils, kadastrālā vērtība, VZD darījumu vēsture šajā mājā, energosertifikāts, apgrūtinājumi un teritorijas zonējums.

---

## 4. Tehnoloģiskā Stack Realizācija

* **Backend:** Go 1.23 (`api/main.go`) ar `pgxpool` un PostGIS telpiskajiem vaicājumiem (`ST_MakeEnvelope`, `ST_Contains`).
* **Frontend:** React 18, TypeScript, MapLibre GL JS, Tailwind/Vanilla CSS komponentes.
* **Kešošana:** In-memory Go cache biežākajiem vaicājumiem un `Cache-Control` hederi Nginx līmenī.
* **Serveris:** Produkcijas vide `65.21.182.7` (Docker Compose: `api`, `web`, `db`, `martin`).

---

## 5. Izpildes Grafiks un Kontrolpunkti

| Solis | Darbība | Rezultāts |
| :--- | :--- | :--- |
| **1. Solis** | Go API endpoints `/api/meklet-stats` un `/api/search` | Ātrs JSON API visiem 4 režīmiem ar filtriem un `bbox`. |
| **2. Solis** | Frontend lapas karkass `/meklet` un URL stāvoklis | Režīmu pārslēdzējs, filtru josla un pamatdizains. |
| **3. Solis** | Datu tabula un Paginācija | Pilns sludinājumu, darījumu un īpašumu saraksts ar cenām, m² un atlaidēm. |
| **4. Solis** | Split-Screen kartes integrācija | Sinhronizēta MapLibre karte ar "Seko kartei" režīmu. |
| **5. Solis** | Modālie logi un slīpēšana | Sludinājuma un īpašuma atskaišu atvēršana, mobilo ierīču adaptācija. |
| **6. Solis** | Testēšana un palaišana produkcijā | Build, deploy uz `kartes.kilograms.lv/meklet` un gala verifikācija. |
