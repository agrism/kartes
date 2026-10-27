# 🗺️ Kadastra un Nekustamo Īpašumu Kartes Platforma

Moderna, neatkarīga un ārkārtīgi ātra Latvijas kadastra, nekustamo īpašumu tirgus darījumu un sludinājumu kartes platforma.

> **Infrastruktūras princips:** **100% Docker vide** — viss (ieskaitot Go kompilāciju un Node/Vite bibliotēkas) tiek būvēts un palaists konteineros. Lokāli datorā nav nepieciešams instalēt nedz Go, nedz Node, nedz PostgreSQL.

---

## 🔌 Sistēmas Portu Reģistrs (Ports Reference)

| Ports | Serviss | Konteiners | Tehnoloģija | Apraksts & Piekļuve |
| :---: | :--- | :--- | :--- | :--- |
| **`5173`** | **Frontend UI** | `kartes-web` | React 18 + Vite + MapLibre | Lietotāja saskarne un karte: [http://localhost:5173](http://localhost:5173) |
| **`8080`** | **Backend API** | `kartes-api` | Go 1.23 + `pgx/v5` | REST API serviss: [http://localhost:8080/api/health](http://localhost:8080/api/health) |
| **`3000`** | **Tile Server** | `kartes-martin` | Martin (Rust) | MVT vektoru flīžu katalogs: [http://localhost:3000/catalog](http://localhost:3000/catalog) |
| **`5432`** | **Datubāze** | `kartes-db` | PostGIS 3.5 (PostgreSQL 17) | Ģeotelpiskais kodols (Host: `localhost:5432`) |
| **`6379`** | **In-Memory Kešs**| `kartes-cache` | Dragonfly (C++) | 25× ātrāks Redis aizstājējs zibenīgai atmiņas kešošanai |
| **`5050`** | **DB Pārlūks** *(izvēles)*| `kartes-pgadmin`| pgAdmin 4 | Datubāzes Web GUI: [http://localhost:5050](http://localhost:5050) |

---

## 🚀 Ātrā Palaišana (Quick Start)

Pārliecinies, ka tavā datorā ir palaists Docker, un izpildi vienu komandu:

```bash
docker compose up -d --build
```

Pēc dažu sekunžu būvēšanas un starta:
1. Atver karti pārlūkā: **[http://localhost:5173](http://localhost:5173)**
2. Pārbaudi API statusu: **[http://localhost:8080/api/health](http://localhost:8080/api/health)**
3. Apskati MVT flīžu katalogu: **[http://localhost:3000/catalog](http://localhost:3000/catalog)**

---

## 🛠️ API Pārbaudes Galapunkti (Endpoints)

Go REST API nodrošina tūlītēju atbildi (< 2 ms):

* **Veselības pārbaude:**
  ```bash
  curl http://localhost:8080/api/health
  ```
* **Adrešu meklēšana un ieteikumi (Autofinišs ar latviešu valodas atbalstu):**
  ```bash
  curl "http://localhost:8080/api/address-suggest?q=Doma"
  ```
* **Zemes vienības profils (Pēc kadastra numura):**
  ```bash
  curl "http://localhost:8080/api/parcel-info?code=01000070001"
  ```
* **Īpašuma vēsturiskie darījumi (VZD NĪTB):**
  ```bash
  curl "http://localhost:8080/api/transactions?cadastre=01000070001"
  ```
* **Martin vektoru flīzes:**
  ```text
  http://localhost:3000/parcels/{z}/{x}/{y}
  ```

---

## 📂 Projekta Struktūra

```text
├── api/                       # Go REST API serviss
│   ├── Dockerfile             # Multi-stage būvēšanas fails
│   ├── go.mod                 # Go atkarības (pgx/v5)
│   └── main.go                # API maršruti, DB savienojums, CORS
├── web/                       # React Frontend serviss
│   ├── Dockerfile             # Node 22 izstrādes konteiners
│   ├── package.json           # MapLibre GL JS, React, Vite
│   ├── vite.config.ts         # Vite ar HMR Docker konfigurāciju
│   └── src/
│       ├── App.tsx            # Kartes dzinējs, meklēšana un informācijas panelis
│       └── index.css          # Pielāgota dizaina sistēma un paneļu stili
├── docker/
│   └── init-db/
│       └── 01-init.sql        # PostGIS inicializācija, shēma, indeksi un demo dati
├── .env                       # Lokālā vides konfigurācija (porti, paroles)
├── .env.example               # Vides konfigurācijas paraugs
├── docker-compose.yml         # Galvenais Docker orķestrētājs (6 servisi)
└── KADASTRA_KARTE_SPECIFIKACIJA.md # Visaptveroša datu un arhitektūras specifikācija
```

---

## 🧰 Noderīgas Komandas

* **Apturēt visus servisus:**
  ```bash
  docker compose down
  ```
* **Apskatīt konteineru žurnālus (logs):**
  ```bash
  docker compose logs -f
  # vai konkrētam servisam:
  docker compose logs -f api
  docker compose logs -f web
  ```
* **Palaist ar pgAdmin grafisko rīku:**
  ```bash
  docker compose --profile tools up -d
  # Piekļuve http://localhost:5050 (Lietotājs: admin@kartes.local / Parole: admin)
  ```
