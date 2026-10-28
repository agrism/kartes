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
| **1. Sludinājumu punkti** | `web/public/data/listings-pts.json` | Pašu crawler/skreiperis (ss.com, city24, pp.lv) | ⏳ **Jāveic (1. uzdevums)** |
| **2. Darījumu tālummaiņas punkti ($Z < 14$)** | `web/public/data/tx-pts.json` | Ģenerēts no mūsu PostGIS `transactions` | ⏳ **Jāveic (2. uzdevums)** |
| **3. Zemes vienības & būves visā Latvijā** | Hosta Nginx `proxy_pass` uz kadastrakarte.lv | VZD Kadastra dati visai LV mūsu PostGIS | ⏳ **Jāveic (3. uzdevums)** |
| **4. Valsts plānojuma & risku slāņi** | Hosta Nginx `proxy_pass /tiles/` | PostGIS + Martin (TAPIS, BIS, VMD, LVĢMC, DAP) | ⏳ **Jāveic (4. uzdevums)** |
| **5. Go API fallback ārpus Rīgas** | `api/main.go` rezerves pieprasījums | Mūsu PostGIS datubāze bez ārējiem fallback | ⏳ **Jāveic (5. uzdevums)** |

---

## 2. Veicamo Darbu Saraksts (Roadmap)

### 📌 1. Uzdevums: Pašu Sludinājumu Dzinējs (ss.com Scraper & Geocoder)
- [ ] **1.1. Scraper servisa izveide:**
  - Izstrādāt Python/Go rāpuli (crawler), kas periodiski (katru stundu / dienu) nolasa aktuālos nekustamā īpašuma sludinājumus no `ss.com` (dzīvokļi, mājas, zeme, telpas, īre).
  - Vākt strukturētus laukus: cena, platība, istabas, stāvs, sērija, adrese, apraksts, bilžu URL un tiešā saite uz sludinājumu.
- [ ] **1.2. Ģeokodēšanas un adrešu sasaistes dzinējs:**
  - Automātiski salīdzināt sludinājumā norādīto adresi ar mūsu PostGIS `addresses` tabulu un piešķirt precīzas koordinātas (`geom`).
  - Sasaistīt sludinājumu ar attiecīgo kadastra zemes vienību (`cadastre_code`).
- [ ] **1.3. Datu bāzes tabula un API:**
  - Izveidot PostgreSQL tabulu `listings` ar indeksiem `GIST(geom)` un `cadastre_code`.
  - Izveidot API gala punktu `/api/listings` un `/api/listings/{id}` detalizētas kartītes atvēršanai kartē.
- [ ] **1.4. Kartes datu atjaunošana:**
  - Ģenerēt `listings-pts.json` automātiski no `listings` tabulas vai nodrošināt MVT vektoru flīzes caur Martin.

---

### 📌 2. Uzdevums: Vietējā Darījumu Klasteru Ģenerēšana ($Z < 14$)
- [ ] **2.1. Punktu ģenerēšanas skripts:**
  - Izveidot skriptu `importer/generate_tx_pts.py`, kas nolasa visus darījumus no mūsu PostGIS tabulas `transactions`.
  - Pārvērst koordinātas delta-kodētā masīvā vai kompaktā GeoJSON formātā (identiski kā `tx-pts.json`).
- [ ] **2.2. Automātiska regulārā atjaunošana:**
  - Pievienot šo soli pie katras VZD darījumu ielādes, lai `web/public/data/tx-pts.json` vienmēr tiktu ģenerēts no mūsu pašu datubāzes.

---

### 📌 3. Uzdevums: Visas Latvijas Kadastra Datu Ielāde (Ārpus Rīgas)
- [ ] **3.1. Visu Latvijas reģionu kadastra datu lejupielāde:**
  - Pašlaik datubāzē ir ielādēts tikai Rīgas kadastrs (`0001000_kk_shp.zip`).
  - Paplašināt `importer/importer.py`, lai tas secīgi lejupielādē un ielādē visus Latvijas novadu VZD kadastra atvērtos datus no `data.gov.lv`:
    - Kurzeme, Zemgale, Vidzeme, Latgale, Pierīga.
- [ ] **3.2. Būvju kontūru pilnais imports:**
  - Ielādēt visas Latvijas ēku kontūras (`KKBuilding.shp`) un parametru datus no VZD.
- [ ] **3.3. Telpiskie indeksi un veiktspēja:**
  - Pārliecināties, ka `parcels` un `buildings` tabulām ir optimizēti `SP-GiST` vai `GIST` indeksi, un izpildīts `VACUUM ANALYZE`.
- [ ] **3.4. Fallback noņemšana no Go API:**
  - Failā `api/main.go` dzēst rezerves koda blokus (līnijas 160-180 un 495-515), kas vaicā `kadastrakarte.lv/api/parcel-info.php`.

---

### 📌 4. Uzdevums: Valsts Reģistru un Vides Risku Slāņu Integrācija
Ielādēt primāros valsts atvērtos datus mūsu PostGIS un pieslēgt mūsu **Martin** flīžu serverim:

- [ ] **4.1. TAPIS Teritorijas zonējums:**
  - Avots: Valsts vienotais ģeotelpiskās informācijas portāls (`geolatvija.lv/geo/tapis`) / `data.gov.lv`.
  - Formāts: GeoPackage / SHP -> PostGIS tabula `tapis_zoning`.
  - Pieslēgums: `kartes-martin:3050/tapis_zoning`.
- [ ] **4.2. BIS Būvniecības ieceres un atļaujas:**
  - Avots: Būvniecības informācijas sistēma (BIS) / `data.gov.lv`.
  - Formāts: CSV ar adresi/kadastru -> PostGIS tabula `construction_cases`.
  - Pieslēgums: `kartes-martin:3050/construction_cases`.
- [ ] **4.3. VMD Meža valsts reģistrs:**
  - Avots: Valsts meža dienests (VMD) atvērtie dati no `data.gov.lv`.
  - Formāts: GeoPackage / SHP -> PostGIS tabula `mvr_nogabali`.
  - Pieslēgums: `kartes-martin:3050/mvr_nogabali`.
- [ ] **4.4. Ceļu servitūti un apgrūtinājumi:**
  - Avots: VZD Apgrūtināto teritoriju informācijas sistēma (ATIS) no `data.gov.lv`.
  - Formāts: SHP -> PostGIS tabula `way_restrictions`.
  - Pieslēgums: `kartes-martin:3050/way_restrictions`.
- [ ] **4.5. Dabas liegumi, mikroliegumi un dižkoki:**
  - Avots: Dabas aizsardzības pārvalde (DAP) OZOLS datubāze no `data.gov.lv`.
  - Formāts: SHP / WFS -> PostGIS tabulas `protected_areas` un `nature_monuments`.
  - Pieslēgums: `kartes-martin:3050/mv_protected_areas` un `mv_nature_monuments`.
- [ ] **4.6. LVĢMC Plūdu riska zonas:**
  - Avots: Latvijas Vides, ģeoloģijas un meteoroloģijas centrs (`videscentrs.lvgmc.lv`).
  - Formāts: Pavasara un jūras plūdu 10%, 1%, 0.5% varbūtības SHP -> PostGIS tabula `flood_zones`.
  - Pieslēgums: `kartes-martin:3050/flood_zones`.
- [ ] **4.7. Vidi degradējošās ēkas (Grausti):**
  - Avots: Rīgas dome un pašvaldību atvērtie dati (`grausti.riga.lv`).
  - Formāts: JSON/CSV -> PostGIS tabula `degrading_buildings`.
- [ ] **4.8. Skolas un sabiedriskais transports:**
  - Avots: IZM / Autotransporta direkcija / OpenStreetMap.
  - Formāts: GeoJSON -> `web/public/data/izgl.geojson` un `transports.geojson`.

---

### 📌 5. Uzdevums: Nginx Proxy Atslēgšana un Arhitektūras Noslēgšana
- [ ] **5.1. Nginx konfigurācijas tīrīšana uz servera:**
  - Failā `/etc/nginx/sites-enabled/kartes.kilograms.lv` izdzēst:
    ```nginx
    # ŠĪS RINDAS TIKS DZĒSTAS:
    location /data/ { proxy_pass https://kadastrakarte.lv/data/; ... }
    location /tiles/ { proxy_pass https://kadastrakarte.lv/tiles/; ... }
    ```
- [ ] **5.2. Pārslēgšana uz lokālo Martin serveri:**
  - Aizstāt ar tiešu lokālo proxy uz mūsu Martin instanci:
    ```nginx
    location /tiles/ {
        proxy_pass http://127.0.0.1:3050/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        add_header Cache-Control "public, max-age=86400";
    }
    ```
- [ ] **5.3. Gala verifikācija:**
  - Pārbaudīt, ka pārlūka izstrādātāja rīkos (Network panelī) neviens pieprasījums vairs neiet caur vai uz `kadastrakarte.lv`.
  - Pārliecināties par pilnīgu sistēmas autonomiju un datu integritāti.
