# Datu Neatkarības Rīcības Plāns: Pāreja uz Primārajiem Ārējiem Avotiem

> **Stratēģiskais mērķis:** 100% neatkarība no `kadastrakarte.lv`.  
> `kadastrakarte.lv` projektā tiek izmantots **tikai kā dizaina un funkcionālais paraugs (UI/UX etalons)**.  
> Visiem ražošanas datiem jānāk no primārajiem valsts atvērtajiem avotiem (`data.gov.lv`, VZD, VMD, TAPIS, BIS, LVĢMC, DAP, BVKB) un pašu izveidotajiem sludinājumu skreiperiem.

---

## 1. Pašreizējā Stāvokļa Audits

| Komponente / Datu kopa | Pašreizējais avots | Mērķa primārais avots | Statuss |
| :--- | :--- | :--- | :--- |
| **Bāzes karte** | OpenFreeMap Positron (OSM) | OpenFreeMap / OSM | ✅ 100% Neatkarīgs |
| **Satelīta aerofoto** | Esri World Imagery | Esri / LĢIA Ortofoto WMTS | ✅ 100% Neatkarīgs |
| **Rīgas zemes vienības & būves** | Mūsu PostGIS (`kartes-db`) | VZD Kadastra atvērtie dati (`data.gov.lv`) | ✅ 100% Neatkarīgs |
| **Valsts adrešu reģistrs** | Mūsu PostGIS (`kartes-db`) | VZD Valsts adrešu reģistrs (`data.gov.lv`) | ✅ 100% Neatkarīgs |
| **Ēku energosertifikāti** | Mūsu Martin (`/tiles/energy_certificates/`) | BVKB atvērtie dati (`data.gov.lv`) | ✅ 100% Neatkarīgs |
| **Piesārņotās vietas** | Mūsu Martin (`/tiles/pollution_sites/`) | VVD atvērtie dati (`data.gov.lv`) | ✅ 100% Neatkarīgs |
| **VZD Darījumu vēsture (Rīga)** | Mūsu PostGIS (`kartes-db`) | VZD NĪTB atvērtie dati (`data.gov.lv`) | ✅ 100% Neatkarīgs |
| **1. Sludinājumu punkti & dzinējs** | `web/public/data/listings-pts.json` | Pašu multi-source skreiperi (`ss.com`, `city24.lv`, `izsoles.ta.gov.lv`) ar PostGIS ģeokodēšanu, kadastra piesaisti un Smart Reaper | ✅ **100% Neatkarīgs** |
| **2. Darījumu tālummaiņas punkti ($Z < 14$)** | `web/public/data/tx-pts.json` | 100% ģenerēts no mūsu PostGIS `transactions` ar `generate_tx_pts.py` un dinamiski caur `/api/tx-pts` | ✅ **100% Neatkarīgs** |
| **3. Zemes vienības & būves visā Latvijā** | Mūsu PostGIS (`kartes-db`) + Martin | VZD Kadastra atvērtie dati (1 055 605 zemes vienības, 1 472 356 ēkas) | ✅ **100% Neatkarīgs** |
| **4. Valsts plānojuma & risku slāņi** | Mūsu PostGIS (`kartes-db`) + Martin | PostGIS + Martin (TAPIS, BIS, VMD, LVĢMC, DAP, Rīgas dome) | ✅ **100% Neatkarīgs** |
| **5. Go API & Nginx proxy neatkarība** | Mūsu PostGIS + Martin (port 3050) | 0% proxy uz kadastrakarte.lv, 100% lokāls kodols | ✅ **100% Neatkarīgs** |

---

## 2. Veicamo Darbu Saraksts (Roadmap)

### 📌 1. Uzdevums: Daudzu Avotu Sludinājumu Dzinējs & Dinamiskie Signāli (Multi-Portal Scraper Engine) - ✅ PABEIGTS
- [x] **1.1. Multi-resursu datubāzes shēma:**
  - Izveidota tabula `public.listings` ar atbalstu vairākiem avotiem (`source`: `ss.com`, `city24.lv`, `pp.lv`, `izsoles.ta.gov.lv`), unikālu atslēgu `UNIQUE(source, external_id)`, cenu dinamiku (`first_price`, `last_price`), dienām tirgū (`days_on_market`), telpisko punktu `geom` un sasaisti ar kadastru `cadastre_code`.
  - Pievienota kolonna `closed_at TIMESTAMP WITH TIME ZONE` un indekss `idx_listings_closed_at` noslēgto sludinājumu uzskaitei.
  - Izveidota tabula `public.listing_price_changes` vēsturisko cenu lēcienu un atlaižu reģistrēšanai (`listing_id`, `change_date`, `old_price`, `new_price`, `delta_amount`, `delta_percent`).
  - Izveidota tabula `public.scraper_runs` ar cikliskās veselības, kļūdu un statistikas uzskaiti.
- [x] **1.2. Vēsturiskā sākuma datu ielāde (Initial Historical Seed):**
  - Ieviestais skripts `importer/seed_listings.py` sekmīgi ielādējis aktīvos sludinājumus kopā ar to vēsturisko cenu izmaiņu hronoloģiju, bildēm, dienām tirgū un sasaisti ar kadastra vienībām (>21 400 sludinājumu datubāzē).
- [x] **1.3. Modulārs skreiperu karkass & Smart Reaper:**
  - `importer/scrapers/base.py` – unificēts modelis (`ListingItem`) un abstrakts bāzes skreiperis ar cenu tūkstošu atdalītāju normalizāciju.
  - `importer/scrapers/ss_com.py` – `ss.com` periodiskais skreiperis (dzīvokļi, mājas, zeme, komerctelpas, īre) ar augstas izšķirtspējas `.800.jpg` attēlu un kadastra numuru ieguvi.
  - `importer/scrapers/city24.py` – `city24.lv` oficiālā REST API integrācija ar koordinātām un fotogrāfijām.
  - `importer/scrapers/izsoles.py` – valsts tiesu un maksātnespējas izsoļu modulis (`izsoles.ta.gov.lv`) ar 11-zīmju kadastra numuru automātisku nolasīšanu.
  - `importer/scrapers/pipeline.py` – PostGIS ģeokodēšana ar `addresses`, kadastra zemes vienības noteikšana ar `parcels` (`ST_Contains`), cenu dinamikas fiksēšana, pirkstu nospiedumu (`fingerprint`) pārbaude un ID kolīziju novēršana.
  - `importer/scrapers/reaper.py` – Smart Reaper (HTTP 404, slēgšanas teksta paziņojumi, automašīnu un citu kategoriju kolīziju atklāšana).
  - `importer/run_scrapers.py` – vienots palaidējs ar `--source`, `--limit`, `--mode`, `--reap`, `--smart-reap` un `--daemon`.
  - `scripts/scrape_listings.sh` – automatizācija ar `flock` bloķēšanu un `timeout 1200` watchdog aizsardzību periodiskajam `cron` darbam.
- [x] **1.4. Go API gala punkti (Dinamiskie JSON dati & Monitorings):**
  - `/api/listings` – atgriež filtrētus sludinājumus GeoJSON formātā (pēc `portal`, `bbox`, `price_drop`, `is_auction`, `is_active = true`).
  - `/api/listings/{id}` – atgriež sludinājuma pilno aprakstu, fotogrāfijas un hronoloģisko cenu vēsturi (`price_history`).
  - `/api/popup-signals` – aprēķina un atgriež nekustamā īpašuma signālus tieši no mūsu PostGIS (darījumi, mediāna, apgrūtinājumi, zonējums, vides riski).
  - `/api/scraper-status` & `/api/scraper-runs` – reāllaika skreiperu veselības audits un pēdējo 20 ciklu atskaite.
- [x] **1.5. Frontend interaktīvā kartīte un vēstures logs:**
  - Sludinājumu punkti tieši no mūsu Go API ar cenu birkām.
  - Portālu filtri (SS.com, City24, Izsoles, Cenas kritumi).
  - Uznirstošais logs (popup): fotogrāfija, cena ar €/m², specifikācija, atlaides %, dienas tirgū, ātrā saite uz portālu un īpašuma signālu kopsavilkums.
  - Vēstures modālais logs ar cenu soļu grafiku un attēlu galeriju.

---

### 📌 2. Uzdevums: Vietējā Darījumu Klasteru Ģenerēšana ($Z < 14$) - ✅ PABEIGTS
- [x] **2.1. Punktu ģenerēšanas skripts:**
  - Izveidots skripts `importer/generate_tx_pts.py`, kas nolasa visus darījumus no mūsu PostGIS tabulas `public.transactions` (>197 000 darījumu punktu).
  - Sakārto punktus telpiski un veic delta-kodēšanu (`[dx, dy, type, ...]`), ģenerējot kompaktu `tx-pts.json` failu.
- [x] **2.2. Dinamiskais Go API gala punkts:**
  - Izveidots endpoints `/api/tx-pts` Go API kodolā (`api/main.go`), kas nodrošina dinamisku darījumu punktu padošanu tieši no PostGIS ar atmiņas kešošanu un 1-stundas `Cache-Control`.
- [x] **2.3. Frontend integrācija:**
  - `web/src/App.tsx` atjaunināts, lai ielādētu datus no `${API_BASE}/api/tx-pts` ar automātisku rezervi uz statisko `/data/tx-pts.json`.

---

### 📌 3. Uzdevums: Visas Latvijas Kadastra Datu Ielāde (Ārpus Rīgas) - ✅ PABEIGTS
- [x] **3.1. Visu Latvijas reģionu kadastra datu lejupielāde un ielāde:**
  - Ielādēti visi 42 Latvijas pašvaldību reģioni no VZD atvērtajiem datiem (`data.gov.lv` CKAN pakotne `b28f0eed-73b0-4e44-94e7-b04b11bf0b69`).
  - Izveidota `public.imported_cadastre_territories` reģistrācijas tabula kļūdu noturībai.
  - Pagaidu zip faili pēc katra novada apstrādes tiek dzēsti, atstājot diska brīvo vietu > 3.5 GB.
- [x] **3.2. Būvju kontūru pilnais imports:**
  - Ielādētas 1 472 356 būvju kontūras (`KKBuilding.shp`) ar sasaisti pie kadastra zemes vienībām un Web Mercator (EPSG:3857) ģeometriju.
  - Ielādētas 1 055 605 zemes vienības (`KKParcel.shp`) visā Latvijas teritorijā.
- [x] **3.3. Telpiskie indeksi un veiktspēja:**
  - `parcels` un `buildings` tabulām izveidoti GIST telpiskie indeksi un B-tree koda indeksi.
  - Izpildīts `VACUUM ANALYZE public.parcels; VACUUM ANALYZE public.buildings;`.
  - Hosta Nginx konfigurēts ar tiešu proxy uz lokālo Martin serveri (`/tiles/parcels/` un `/tiles/buildings/`).
- [x] **3.4. Fallback noņemšana no Go API:**
  - No `api/main.go` pilnībā izdzēsti rezerves koda bloki (`fetchRemoteParcelInfo`, `fetchRemoteParcelTransactions` un kešošana).
  - Pievienota dinamiska adrešu telpiskā sasaiste no `public.addresses` gadījumos, kad adrese vēl nav iepriekš piešķirta.

---

### 📌 4. Uzdevums: Valsts Reģistru un Vides Risku Slāņu Integrācija - ✅ PABEIGTS
Ielādēti primārie valsts atvērtie dati mūsu PostGIS un pieslēgti mūsu **Martin** flīžu serverim:

- [x] **4.1. TAPIS Teritorijas zonējums:**
  - Avots: Valsts atvērtie dati (`data.gov.lv` GPKG).
  - Statuss: 6 132 funkcionālās zonas ar indeksiem (`DzS`, `DzM`, `JC`, `ML` u.c.) un apbūves stāvu skaitu PostGIS tabulā `public.tapis_zonejums`.
  - Pieslēgums: `kartes-martin:3050/tapis_zonejums`.
- [x] **4.2. BIS Būvniecības ieceres un atļaujas:**
  - Avots: Būvniecības informācijas sistēma (BIS) / `data.gov.lv`.
  - Statuss: 61 993 būvniecības lietas ar precīzu koordinātu sasaisti pie `buildings` kontūrām PostGIS tabulā `public.construction_cases`.
  - Pieslēgums: `kartes-martin:3050/construction_cases`.
- [x] **4.3. VMD Meža valsts reģistrs:**
  - Avots: Valsts meža dienests (VMD) MVR nogabali.
  - Statuss: 193 867 meža nogabalu poligoni PostGIS tabulā `public.mv_mezi_med` un skatā `public.mvr_nogabali`.
  - Pieslēgums: `kartes-martin:3050/mv_mezi_med` un `kartes-martin:3050/mvr_nogabali`.
- [x] **4.4. Ceļu servitūti un apgrūtinājumi:**
  - Avots: VZD Apgrūtināto teritoriju informācijas sistēma (ATIS) no `data.gov.lv`.
  - Statuss: 1 351 apgrūtinājumu un servitūtu poligons PostGIS tabulā `public.way_restrictions`.
  - Pieslēgums: `kartes-martin:3050/way_restrictions`.
- [x] **4.5. Dabas liegumi, mikroliegumi un dižkoki:**
  - Avots: Dabas aizsardzības pārvalde (DAP) OZOLS datubāze no `data.gov.lv`.
  - Statuss: 3 988 ĪADT un mikroliegumu poligoni tabulā `public.mv_protected_areas` un 16 503 dižkoki/akmeņi tabulā `public.mv_nature_monuments`.
  - Pieslēgums: `kartes-martin:3050/mv_protected_areas` un `kartes-martin:3050/mv_nature_monuments`.
- [x] **4.6. LVĢMC Plūdu riska zonas:**
  - Avots: Latvijas Vides, ģeoloģijas un meteoroloģijas centrs (LVĢMC).
  - Statuss: 13 394 pavasara 100 gadu plūdu poligoni tabulā `public.flood_zone_spring_100y` un 1 863 jūras vējuzplūdu poligoni tabulā `public.flood_zone_sea_100y`.
  - Pieslēgums: `kartes-martin:3050/flood_zone_spring_100y` un `kartes-martin:3050/flood_zone_sea_100y`.
- [x] **4.7. Vidi degradējošās ēkas (Grausti):**
  - Avots: Rīgas dome un pašvaldību atvērtie dati no `data.gov.lv`.
  - Statuss: 1 574 degradēto ēku poligoni ar kadastra sasaisti tabulā `public.degrading_buildings`.
  - Pieslēgums: `kartes-martin:3050/degrading_buildings`.
- [x] **4.8. Skolas un sabiedriskais transports:**
  - Avots: Atvērtie dati.
  - Statuss: `web/public/data/izgl.geojson` un `transports.geojson` tiek servēti lokāli caur Nginx.

---

### 📌 5. Uzdevums: Nginx Proxy Atslēgšana un Arhitektūras Noslēgšana - ✅ PABEIGTS
- [x] **5.1. Nginx konfigurācijas tīrīšana uz servera:**
  - Failā `/etc/nginx/sites-enabled/kartes.kilograms.lv` pilnībā izdzēsts attālinātais `proxy_pass https://kadastrakarte.lv/`.
- [x] **5.2. Pārslēgšana uz lokālo Martin serveri:**
  - Visi `/tiles/` pieprasījumi tiek novirzīti tieši uz `http://127.0.0.1:3050/` ar 24h kešošanu:
    ```nginx
    location /tiles/ {
        proxy_pass http://127.0.0.1:3050/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        add_header Cache-Control "public, max-age=86400";
    }
    ```
- [x] **5.3. Gala verifikācija:**
  - Pārbaudīts, ka visi 17 vektoru flīžu un datu gala punkti atgriež `200 OK` tieši no vietējās infrastruktūras.
  - Tīkla plūsmā uz `kadastrakarte.lv` ir 0 pieprasījumu. Pilnīga datu autonomija un ātrdarbība.

