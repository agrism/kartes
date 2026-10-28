#!/usr/bin/env python3
"""
VZD Atvērto Datu Ielādes Dzinējs (High-Performance PostGIS Importer)
Nodrošina kadastra zemes vienību, būvju kontūru, darījumu (NĪTB) un adrešu ātru ielādi ar streaming COPY.
"""

import os
import sys
import io
import csv
import json
import zipfile
import argparse
import unicodedata
import requests
from tqdm import tqdm
import psycopg
import shapefile
from shapely.geometry import shape

DB_URL = os.environ.get("DATABASE_URL", "postgresql://kartes:kartes_secret_password@db:5432/kartes")
CACHE_DIR = os.environ.get("CACHE_DIR", "/app/cache")

URLS = {
    "transactions_zv": "https://data.gov.lv/dati/dataset/c6cadef0-248a-4ac7-8ab6-bc6a49e7a807/resource/a6ea0267-06b6-4f76-93dd-df54d13b5f95/download/zv_darijumi_01012016-30092026.csv",
    "cadastre_riga": "https://data.gov.lv/dati/dataset/b28f0eed-73b0-4e44-94e7-b04b11bf0b69/resource/bf88b763-98b8-445d-a51f-b76f45c362c5/download/0001000_kk_shp.zip",
    "addresses_eka": "https://data.gov.lv/dati/dataset/6b06a7e8-dedf-4705-a47b-2a7c51177473/resource/a510737a-18ce-400f-ad4b-04fce5228272/download/aw_eka.csv",
    "energy_certificates": "https://data.gov.lv/dati/dataset/075498f5-0136-47d7-af86-0066acb0264c/resource/212c0946-a06e-4c2c-8112-833b2969b44b/download/eku-energosertifikati-27.10.2026.csv",
    "pollution_sites": "https://data.gov.lv/dati/lv/dataset/66a30fa4-9401-4885-9de0-e2c76dd5f4d4/resource/c726cad3-ab66-4b57-96b9-a6cc715fe693/download/pppv_zemes-portalam_10.2024.csv",
}

def download_file(url: str, filename: str) -> str:
    """Lejupielādē failu kešatmiņā ar progresa joslu, ja tas vēl nav lejupielādēts."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    dest_path = os.path.join(CACHE_DIR, filename)

    if os.path.exists(dest_path) and os.path.getsize(dest_path) > 0:
        print(f"📦 Izmanto kešoto failu: {dest_path} ({os.path.getsize(dest_path) // (1024*1024)} MB)")
        return dest_path

    print(f"⬇️ Lejupielādē no {url} ...")
    resp = requests.get(url, stream=True, timeout=120)
    resp.raise_for_status()

    total_size = int(resp.headers.get('content-length', 0))
    with open(dest_path, 'wb') as f, tqdm(total=total_size, unit='B', unit_scale=True, desc=filename) as pbar:
        for chunk in resp.iter_content(chunk_size=131072):
            if chunk:
                f.write(chunk)
                pbar.update(len(chunk))

    print(f"✅ Lejupielādēts veiksmīgi: {dest_path}")
    return dest_path

def get_cadastre_resources() -> list[dict]:
    """Iegūst visu 42 Latvijas pašvaldību kadastra datu kopas no data.gov.lv CKAN API ar lokālu fallback."""
    api_url = "https://data.gov.lv/dati/api/3/action/package_show?id=b28f0eed-73b0-4e44-94e7-b04b11bf0b69"
    try:
        r = requests.get(api_url, timeout=15)
        if r.status_code == 200:
            resources = r.json().get("result", {}).get("resources", [])
            shp_res = [res for res in resources if res.get("url", "").endswith(".zip")]
            if len(shp_res) >= 40:
                return [{"name": res.get("name"), "url": res.get("url"), "size": res.get("size", 0)} for res in shp_res]
    except Exception as e:
        print(f"⚠️ Neizdevās nolasīt CKAN API ({e}), izmanto lokālo resursu sarakstu.")

    local_json = os.path.join(os.path.dirname(__file__), "cadastre_resources.json")
    if os.path.exists(local_json):
        with open(local_json, "r", encoding="utf-8") as f:
            return json.load(f)
    return []

def init_cadastre_tracking(conn):
    """Izveido reģistru ielādētajām teritorijām drošai atsākšanai (resumability)."""
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS public.imported_cadastre_territories (
                territory_code varchar(20) PRIMARY KEY,
                name varchar(100),
                imported_at timestamptz DEFAULT CURRENT_TIMESTAMP,
                parcels_count integer DEFAULT 0,
                buildings_count integer DEFAULT 0
            );
        """)
        # Ja parcels tabulā jau ir Rīgas dati, atzīmējam Rīgu kā ielādētu
        cur.execute("SELECT count(*) FROM public.parcels WHERE code LIKE '0100%';")
        riga_cnt = cur.fetchone()[0]
        if riga_cnt > 30000:
            cur.execute("""
                INSERT INTO public.imported_cadastre_territories (territory_code, name, parcels_count, buildings_count)
                VALUES ('0001000', '1. Rīga', %s, (SELECT count(*) FROM public.buildings WHERE parcel_code LIKE '0100%%'))
                ON CONFLICT (territory_code) DO NOTHING;
            """, (riga_cnt,))
        conn.commit()

def process_cadastre_zip(conn, zip_path: str, region_name: str, limit: int = 0) -> tuple[int, int]:
    """Apstrādā vienu kadastra zip arhīvu: nolasa zemes vienības un būvju kontūras ar streaming COPY."""
    with conn.cursor() as cur:
        with zipfile.ZipFile(zip_path, 'r') as zf:
            # 1. Zemes vienības (KKParcel)
            parcel_shps = [n for n in zf.namelist() if n.endswith("KKParcel.shp")]
            print(f"📁 [{region_name}] Apstrādā {len(parcel_shps)} zemes vienību shapefiles...")

            cur.execute("""
                CREATE TEMP TABLE tmp_parcels (
                    code varchar(11),
                    area_m2 numeric(14, 2),
                    wkb_hex text
                ) ON COMMIT DROP;
            """)

            total_parcels = 0
            with cur.copy("COPY tmp_parcels (code, area_m2, wkb_hex) FROM STDIN") as copy:
                for shp_name in tqdm(parcel_shps, desc=f"{region_name} - Zemes vienības"):
                    base = shp_name[:-4]
                    try:
                        shp_io = io.BytesIO(zf.read(base + ".shp"))
                        shx_io = io.BytesIO(zf.read(base + ".shx"))
                        dbf_io = io.BytesIO(zf.read(base + ".dbf"))

                        sf = shapefile.Reader(shp=shp_io, shx=shx_io, dbf=dbf_io, encoding='iso-8859-4')
                        for sr in sf.shapeRecords():
                            code = str(sr.record[0]).strip()
                            if not code:
                                continue

                            s = sr.shape
                            if len(s.points) == 0:
                                continue

                            poly_geom = shape(s.__geo_interface__)
                            wkb_hex = poly_geom.wkb_hex
                            area = round(float(poly_geom.area), 2)

                            copy.write_row((code, area, wkb_hex))
                            total_parcels += 1

                            if limit > 0 and total_parcels >= limit:
                                break
                        if limit > 0 and total_parcels >= limit:
                            break
                    except Exception:
                        continue

            print(f"🚀 [{region_name}] Ievieto {total_parcels} zemes vienības PostGIS (EPSG:3059 -> 3857)...")
            cur.execute("""
                INSERT INTO public.parcels (code, area_m2, geom)
                SELECT DISTINCT ON (code)
                    code, 
                    area_m2, 
                    ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromWKB(decode(wkb_hex, 'hex')), 3059), 3857)), 3))
                FROM tmp_parcels
                WHERE code IS NOT NULL AND code != ''
                ON CONFLICT (code) DO UPDATE
                SET area_m2 = EXCLUDED.area_m2, geom = EXCLUDED.geom;
            """)
            conn.commit()

            # 2. Būvju kontūras (KKBuilding)
            building_shps = [n for n in zf.namelist() if n.endswith("KKBuilding.shp")]
            print(f"📁 [{region_name}] Apstrādā {len(building_shps)} būvju shapefiles...")

            cur.execute("""
                CREATE TEMP TABLE tmp_buildings (
                    code varchar(14),
                    parcel_code varchar(11),
                    wkb_hex text
                ) ON COMMIT DROP;
            """)

            total_buildings = 0
            with cur.copy("COPY tmp_buildings (code, parcel_code, wkb_hex) FROM STDIN") as copy:
                for shp_name in tqdm(building_shps, desc=f"{region_name} - Būves"):
                    base = shp_name[:-4]
                    try:
                        shp_io = io.BytesIO(zf.read(base + ".shp"))
                        shx_io = io.BytesIO(zf.read(base + ".shx"))
                        dbf_io = io.BytesIO(zf.read(base + ".dbf"))

                        sf = shapefile.Reader(shp=shp_io, shx=shx_io, dbf=dbf_io, encoding='iso-8859-4')
                        for sr in sf.shapeRecords():
                            code = str(sr.record[0]).strip()
                            parcel_code = str(sr.record[2]).strip() if len(sr.record) > 2 and sr.record[2] else None
                            if not code:
                                continue

                            s = sr.shape
                            if len(s.points) == 0:
                                continue

                            poly_geom = shape(s.__geo_interface__)
                            wkb_hex = poly_geom.wkb_hex

                            copy.write_row((code, parcel_code, wkb_hex))
                            total_buildings += 1

                            if limit > 0 and total_buildings >= limit:
                                break
                        if limit > 0 and total_buildings >= limit:
                            break
                    except Exception:
                        continue

            print(f"🚀 [{region_name}] Ievieto {total_buildings} būves PostGIS (EPSG:3059 -> 3857)...")
            cur.execute("""
                INSERT INTO public.buildings (code, parcel_code, geom)
                SELECT DISTINCT ON (code)
                    code, 
                    parcel_code, 
                    ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Transform(ST_SetSRID(ST_GeomFromWKB(decode(wkb_hex, 'hex')), 3059), 3857)), 3))
                FROM tmp_buildings
                WHERE code IS NOT NULL AND code != ''
                ON CONFLICT (code) DO UPDATE
                SET parcel_code = EXCLUDED.parcel_code, geom = EXCLUDED.geom;
            """)
            conn.commit()

            print(f"✨ [{region_name}] Veiksmīgi saglabātas {total_parcels} zemes vienības un {total_buildings} būves!")
            return total_parcels, total_buildings

def import_cadastre_riga(limit: int = 0):
    """Importē Rīgas kadastra zemes vienības un būves."""
    import_cadastre_all_latvia(limit=limit, region_filter="0001000", force=True)

def normalize_str(s: str) -> str:
    """Noņem diakritiskās zīmes un pārvērš mazajos burtos ērtai reģionu meklēšanai."""
    if not s:
        return ""
    return unicodedata.normalize('NFKD', s).encode('ASCII', 'ignore').decode('utf-8').lower()

def import_cadastre_all_latvia(limit: int = 0, region_filter: str = None, resume_from: str = None, keep_zips: bool = False, force: bool = False):
    """Secīgi lejupielādē un ielādē visas Latvijas pašvaldību kadastra datus (42 novadi/pilsētas)."""
    resources = get_cadastre_resources()
    if not resources:
        print("❌ Neizdevās iegūt kadastra datu kopu sarakstu!")
        return

    print(f"\n🗺️ Sākam kadastra datu ielādi ({len(resources)} reģioni sarakstā)...")

    with psycopg.connect(DB_URL) as conn:
        init_cadastre_tracking(conn)

        imported_codes = set()
        if not force:
            with conn.cursor() as cur:
                cur.execute("SELECT territory_code FROM public.imported_cadastre_territories;")
                imported_codes = {row[0] for row in cur.fetchall()}

        resuming = resume_from is None
        total_p = 0
        total_b = 0

        for i, res in enumerate(resources, 1):
            name = res["name"]
            url = res["url"]
            filename = url.split("/")[-1]
            t_code = filename.split("_")[0]

            if region_filter:
                rf = normalize_str(region_filter)
                if rf not in normalize_str(name) and rf not in t_code.lower() and rf not in filename.lower():
                    continue

            if not resuming:
                rf = normalize_str(resume_from)
                if rf in normalize_str(name) or rf in t_code.lower():
                    resuming = True
                else:
                    print(f"⏭️ Izlaiž reģionu līdz {resume_from}: {name}")
                    continue

            if not force and t_code in imported_codes:
                print(f"⏭️ [{i}/{len(resources)}] Reģions jau ielādēts: {name} ({t_code})")
                continue

            print(f"\n=======================================================")
            print(f"📍 [{i}/{len(resources)}] APSTRĀDĀ: {name} (Kods: {t_code})")
            print(f"=======================================================")

            zip_path = download_file(url, filename)
            try:
                p_cnt, b_cnt = process_cadastre_zip(conn, zip_path, name, limit=limit)
                total_p += p_cnt
                total_b += b_cnt

                with conn.cursor() as cur:
                    cur.execute("""
                        INSERT INTO public.imported_cadastre_territories (territory_code, name, imported_at, parcels_count, buildings_count)
                        VALUES (%s, %s, NOW(), %s, %s)
                        ON CONFLICT (territory_code) DO UPDATE
                        SET imported_at = NOW(), parcels_count = EXCLUDED.parcels_count, buildings_count = EXCLUDED.buildings_count;
                    """, (t_code, name, p_cnt, b_cnt))
                    conn.commit()

            finally:
                if not keep_zips and os.path.exists(zip_path):
                    try:
                        os.remove(zip_path)
                        print(f"🧹 Dzēsts pagaidu fails: {filename} (atbrīvota vieta diskā)")
                    except Exception:
                        pass

        print(f"\n🎉 Visi atlasītie reģioni apstrādāti! Ielādētas {total_p} zemes vienības un {total_b} būves.")

    vacuum_cadastre_tables()

def vacuum_cadastre_tables():
    """Izpilda VACUUM ANALYZE kadastra tabulām maksimālai Martin flīžu veiktspējai."""
    print("\n🧹 Izpilda VACUUM ANALYZE public.parcels un public.buildings...")
    try:
        with psycopg.connect(DB_URL, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute("VACUUM ANALYZE public.parcels;")
                cur.execute("VACUUM ANALYZE public.buildings;")
        print("✅ VACUUM ANALYZE veiksmīgi pabeigts!")
    except Exception as e:
        print(f"⚠️ VACUUM brīdinājums: {e}")

import math

def to_web_mercator(lng: float, lat: float) -> tuple[float, float]:
    """Konvertē WGS-84 (EPSG:4326) uz Web Mercator (EPSG:3857)."""
    x = lng * 20037508.342789244 / 180.0
    y = math.log(math.tan((90.0 + lat) * math.pi / 360.0)) / (math.pi / 180.0)
    y = y * 20037508.342789244 / 180.0
    return round(x, 2), round(y, 2)

def import_transactions(limit: int = 0):
    """Importē VZD NĪTB nekustamo īpašumu tirgus darījumus ar ātro COPY un UNLOGGED tabulu."""
    print("\n--- 💼 VZD DARĪJUMU IMPORTS (NĪTB) ---")
    csv_file = download_file(URLS["transactions_zv"], "zv_darijumi.csv")

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            print("📖 Sagatavojam UNLOGGED staging tabulu darījumu streaming COPY...")
            cur.execute("""
                CREATE UNLOGGED TABLE IF NOT EXISTS staging_transactions (
                    deal_id bigint,
                    cadastre_code varchar(11),
                    deal_date date,
                    amount_eur numeric(14, 2),
                    area_m2 numeric(12, 2),
                    price_per_m2 numeric(10, 2),
                    property_type varchar(20),
                    address text
                );
                TRUNCATE staging_transactions;
            """)
            conn.commit()

            count = 0
            seen_deal_ids = set()
            with open(csv_file, 'r', encoding='utf-8-sig', errors='ignore') as f:
                reader = csv.DictReader(f)
                with cur.copy("COPY staging_transactions (deal_id, cadastre_code, deal_date, amount_eur, area_m2, price_per_m2, property_type, address) FROM STDIN") as copy:
                    for row in tqdm(reader, desc="NĪTB darījumi (streaming)", total=205095):
                        try:
                            deal_id = int(row.get("DeaId", 0))
                            if not deal_id or deal_id in seen_deal_ids:
                                continue
                            seen_deal_ids.add(deal_id)

                            par_list = row.get("ParCadNrList", "").strip()
                            pro_cad = row.get("ProCadNr", "").strip()
                            cad_code = (par_list.split(",")[0].strip() or pro_cad)[:11]

                            deal_date = row.get("DeaDate", "").strip() or None
                            amount = float(row.get("DeaAmount", 0) or 0)
                            area = float(row.get("ParTotalArea", 0) or 0)
                            
                            std_addr = row.get("Std", "").strip()
                            city = row.get("ArCity", "").strip()
                            parish = row.get("ArParish", "").strip()
                            addr = std_addr or f"{city}, {parish}".strip(", ")

                            price_m2 = round(amount / area, 2) if area > 0 else 0

                            copy.write_row((deal_id, cad_code, deal_date, amount, area, price_m2, "zv", addr))
                            count += 1

                            if limit > 0 and count >= limit:
                                break
                        except Exception:
                            continue

            conn.commit()
            print(f"🚀 Saglabā {count} unikālus darījumus 'public.transactions' tabulā...")
            cur.execute("DROP INDEX IF EXISTS public.idx_transactions_geom;")
            conn.commit()

            cur.execute("""
                INSERT INTO public.transactions (
                    deal_id, cadastre_code, deal_date, amount_eur, area_m2, price_per_m2, property_type, address
                )
                SELECT deal_id, cadastre_code, deal_date, amount_eur, area_m2, price_per_m2, property_type, address
                FROM staging_transactions
                ON CONFLICT (deal_id) DO UPDATE
                SET cadastre_code = EXCLUDED.cadastre_code,
                    deal_date = EXCLUDED.deal_date,
                    amount_eur = EXCLUDED.amount_eur,
                    area_m2 = EXCLUDED.area_m2,
                    price_per_m2 = EXCLUDED.price_per_m2,
                    address = EXCLUDED.address;
                
                DROP TABLE IF EXISTS staging_transactions;
            """)
            conn.commit()

            # Piesaista punktu koordinātas no zemes vienību centriem
            print("🗺️ Telpiski piesaista koordinātas darījumiem no zemes vienībām...")
            cur.execute("""
                UPDATE public.transactions t
                SET geom = ST_Centroid(p.geom)
                FROM public.parcels p
                WHERE t.cadastre_code = p.code AND p.geom IS NOT NULL AND t.geom IS NULL;
            """)
            conn.commit()

            print("🔨 Atjauno darījumu telpisko indeksu...")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_transactions_geom ON public.transactions USING GIST (geom);")
            conn.commit()
            print(f"✨ Veiksmīgi ielādēti un ģeokodēti {count} NĪTB darījumi!")

def import_addresses(limit: int = 0):
    """Importē Valsts adrešu reģistru ar tiešo Web Mercator COPY un telpiski piesaista kadastram."""
    print("\n--- 📮 VALSTS ADREŠU REĢISTRA IMPORTS (VAR) ---")
    csv_path = download_file(URLS["addresses_eka"], "aw_eka.csv")

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            print("📖 Sagatavojam UNLOGGED staging tabulu adrešu streaming COPY...")
            cur.execute("""
                CREATE UNLOGGED TABLE IF NOT EXISTS staging_addresses (
                    code varchar(20),
                    address text,
                    geom geometry(Point, 3857)
                );
                TRUNCATE staging_addresses;
            """)
            cur.execute("DROP INDEX IF EXISTS public.idx_addresses_trgm;")
            cur.execute("DROP INDEX IF EXISTS public.idx_addresses_geom;")
            conn.commit()

            count = 0
            with open(csv_path, 'r', encoding='utf-8-sig', errors='ignore') as f:
                reader = csv.DictReader(f)
                with cur.copy("COPY staging_addresses (code, address, geom) FROM STDIN") as copy:
                    for row in tqdm(reader, desc="Adrešu reģistrs (streaming)", total=611200):
                        try:
                            # Ņemam tikai eksistējošas adreses
                            if row.get("STATUSS", "").strip() != "EKS":
                                continue

                            kods = row.get("KODS", "").strip()
                            std = row.get("STD", "").strip().strip('"')
                            lat = float(row.get("DD_N", 0) or 0)
                            lng = float(row.get("DD_E", 0) or 0)

                            if not kods or not std or not lat or not lng:
                                continue

                            x, y = to_web_mercator(lng, lat)
                            point_ewkt = f"SRID=3857;POINT({x} {y})"

                            copy.write_row((kods, std, point_ewkt))
                            count += 1

                            if limit > 0 and count >= limit:
                                break
                        except Exception:
                            continue

            conn.commit()
            print(f"🚀 Saglabā {count} adreses 'public.addresses' no staging tabulas...")
            cur.execute("""
                INSERT INTO public.addresses (code, address, geom)
                SELECT code, address, geom
                FROM staging_addresses
                ON CONFLICT (code) DO NOTHING;

                DROP TABLE IF EXISTS staging_addresses;
            """)
            conn.commit()
            print(f"✅ Ielādētas {count} adreses!")

            print("🔨 Atjauno adrešu telpisko un trigramu meklēšanas indeksus...")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_addresses_geom ON public.addresses USING GIST (geom);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_addresses_trgm ON public.addresses USING GIN (address gin_trgm_ops);")
            conn.commit()
            print("✅ Indeksi veiksmīgi atjaunoti!")

            # Telpiskā adrešu piesaiste zemes vienībām
            print("🗺️ Telpiski piesaista adrešu tekstus zemes vienībām pēc telpiskā pārklājuma...")
            cur.execute("""
                UPDATE public.parcels p
                SET address = a.address
                FROM public.addresses a
                WHERE p.address IS NULL 
                  AND p.geom && a.geom 
                  AND ST_Contains(p.geom, a.geom);
            """)
            conn.commit()
            print("✨ Zemes vienību adreses veiksmīgi atjauninātas!")

def get_latest_energy_cert_url() -> str:
    """Iegūst jaunāko energoefektivitātes sertifikātu CSV faila URL no data.gov.lv CKAN API."""
    try:
        r = requests.get("https://data.gov.lv/dati/api/3/action/package_show?id=075498f5-0136-47d7-af86-0066acb0264c", timeout=10)
        if r.status_code == 200:
            for res in r.json().get("result", {}).get("resources", []):
                if res.get("url", "").endswith(".csv"):
                    return res["url"]
    except Exception:
        pass
    return URLS["energy_certificates"]

def import_energy_certificates(limit: int = 0):
    """Importē BVKB ēku energosertifikātus un telpiski piesaista ēkām un zemes vienībām."""
    print("\n--- ⚡ BVKB ĒKU ENERGOSERTIFIKĀTU IMPORTS ---")
    url = get_latest_energy_cert_url()
    filename = url.split("/")[-1] if "/" in url else "eku-energosertifikati.csv"
    csv_path = download_file(url, filename)

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                DROP TABLE IF EXISTS staging_energy_certs;
                CREATE UNLOGGED TABLE staging_energy_certs (
                    doc_number text,
                    doc_type text,
                    status text,
                    issue_date date,
                    valid_until date,
                    cadastre_codes text,
                    building_code varchar(14),
                    parcel_code varchar(11),
                    address text,
                    energy_class text,
                    heating_kwh_m2 numeric(10, 2),
                    area_m2 numeric(16, 2)
                );
            """)
            conn.commit()

            count = 0
            with open(csv_path, 'r', encoding='utf-8-sig', errors='ignore') as f:
                reader = csv.DictReader(f)
                with cur.copy("""
                    COPY staging_energy_certs (
                        doc_number, doc_type, status, issue_date, valid_until,
                        cadastre_codes, building_code, parcel_code, address,
                        energy_class, heating_kwh_m2, area_m2
                    ) FROM STDIN
                """) as copy:
                    for row in tqdm(reader, desc="Energosertifikāti"):
                        doc_num = row.get("Dokumenta_numurs", "").strip()
                        if not doc_num:
                            continue
                        doc_type = row.get("Dokumenta_veids", "").strip()
                        status = row.get("Statuss", "").strip()
                        
                        def parse_date(d_str):
                            d_str = (d_str or "").strip()
                            return d_str[:10] if len(d_str) >= 10 else None
                        
                        issue_date = parse_date(row.get("Izdosanas_datums"))
                        valid_until = parse_date(row.get("Deriguma_termins"))
                        codes_raw = row.get("Objektu_identificejosie_kadastra_apzimejumi", "").strip()
                        addr = row.get("Objekta_adrese", "").strip()
                        e_class = row.get("Ekas_energoefektivitates_klase", "").strip()
                        
                        def parse_float(val, max_val=999999999.0):
                            try:
                                v = float((val or "").replace(",", ".").strip())
                                return round(v, 2) if 0 <= v <= max_val else None
                            except Exception:
                                return None
                        
                        heating_kwh = parse_float(row.get("Energija_apkurei_kwh_m_2_gada"), 999999.0)
                        area_m2 = parse_float(row.get("Kopeja_platiba_m2"), 999999999.0)

                        # Analizē kadastra kodus (14 zīmes = ēka, 11 zīmes = zeme)
                        b_code = None
                        p_code = None
                        tokens = [t.strip() for t in codes_raw.replace(";", ",").split(",") if t.strip()]
                        for t in tokens:
                            if len(t) == 14 and t.isdigit() and not b_code:
                                b_code = t
                            elif len(t) == 11 and t.isdigit() and not p_code:
                                p_code = t
                        if b_code and not p_code:
                            p_code = b_code[:11]

                        copy.write_row((
                            doc_num, doc_type, status, issue_date, valid_until,
                            codes_raw, b_code, p_code, addr,
                            e_class, heating_kwh, area_m2
                        ))
                        count += 1
                        if limit > 0 and count >= limit:
                            break

            conn.commit()
            print(f"🚀 Saglabā {count} energosertifikātus 'public.energy_certificates'...")
            cur.execute("""
                INSERT INTO public.energy_certificates (
                    doc_number, doc_type, status, issue_date, valid_until,
                    cadastre_codes, building_code, parcel_code, address,
                    energy_class, heating_kwh_m2, area_m2
                )
                SELECT DISTINCT ON (doc_number)
                    doc_number, doc_type, status, issue_date, valid_until,
                    cadastre_codes, building_code, parcel_code, address,
                    energy_class, heating_kwh_m2, area_m2
                FROM staging_energy_certs
                ORDER BY doc_number, issue_date DESC NULLS LAST
                ON CONFLICT (doc_number) DO UPDATE
                SET status = EXCLUDED.status,
                    valid_until = EXCLUDED.valid_until,
                    energy_class = EXCLUDED.energy_class,
                    heating_kwh_m2 = EXCLUDED.heating_kwh_m2;

                DROP TABLE IF EXISTS staging_energy_certs;
            """)
            conn.commit()

            print("📍 Piesaista ģeometrijas no ēkām un zemes vienībām...")
            cur.execute("""
                UPDATE public.energy_certificates e
                SET geom = ST_PointOnSurface(b.geom)
                FROM public.buildings b
                WHERE e.building_code = b.code AND e.geom IS NULL;

                UPDATE public.energy_certificates e
                SET geom = ST_PointOnSurface(p.geom)
                FROM public.parcels p
                WHERE e.parcel_code = p.code AND e.geom IS NULL;
            """)
            conn.commit()
            print("✅ Energosertifikāti veiksmīgi ielādēti un telpiski piesaistīti!")

def import_pollution_sites(limit: int = 0):
    """Importē VVD piesārņotās un potenciāli piesārņotās vietas ar precīzām koordinātām."""
    print("\n--- ⚠️ VVD PIESĀRŅOTO UN POTENCIĀLI PIESĀRŅOTO VIETU IMPORTS ---")
    csv_path = download_file(URLS["pollution_sites"], "pppv_zemes_portalam.csv")

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE TABLE public.pollution_sites;")
            conn.commit()

            count = 0
            with open(csv_path, 'r', encoding='utf-8-sig', errors='ignore') as f:
                reader = csv.DictReader(f, delimiter=';')
                with cur.copy("""
                    COPY public.pollution_sites (
                        reg_number, name, place, address, category, site_type, geom
                    ) FROM STDIN
                """) as copy:
                    for row in tqdm(reader, desc="Piesārņotās vietas"):
                        try:
                            reg_num = row.get("Vietas reģistrācijas numurs", "").strip()
                            name = row.get("Vietas nosaukums", "").strip()
                            place = row.get("Novads / Pilsēta", "").strip()
                            addr = row.get("Pilna adrese", "").strip()
                            cat = row.get("Kategorija", "").strip()
                            stype = row.get("Piesārņotās vietas tips", "").strip()
                            lat_str = row.get("Koordinātas Zpl", "").replace(",", ".").strip()
                            lng_str = row.get("Koordinātas Ag", "").replace(",", ".").strip()

                            if not lat_str or not lng_str:
                                continue

                            lat = float(lat_str)
                            lng = float(lng_str)
                            x, y = to_web_mercator(lng, lat)
                            point_ewkt = f"SRID=3857;POINT({x} {y})"

                            copy.write_row((reg_num, name, place, addr, cat, stype, point_ewkt))
                            count += 1
                            if limit > 0 and count >= limit:
                                break
                        except Exception:
                            continue

            conn.commit()
            print(f"✅ Ielādētas {count} piesārņotās un potenciāli piesārņotās vietas!")

def main():
    parser = argparse.ArgumentParser(description="VZD Atvērto Datu Ielādes Rīks (High Performance)")
    parser.add_argument("--cadastre-all", action="store_true", help="Ielādēt visas Latvijas kadastra robežas un būves (42 pašvaldības)")
    parser.add_argument("--cadastre-region", type=str, help="Ielādēt konkrētas pašvaldības kadastru (nosaukums vai kods, piemēram, 'Jurmala' vai '0004000')")
    parser.add_argument("--resume-from", type=str, help="Atsākt kadastra ielādi no konkrēta reģiona")
    parser.add_argument("--keep-zips", action="store_true", help="Saglabāt lejupielādētos zip failus pēc apstrādes")
    parser.add_argument("--force", action="store_true", help="Pārlādēt reģionus pat ja tie jau ir ielādēti")
    parser.add_argument("--vacuum", action="store_true", help="Izpildīt VACUUM ANALYZE kadastra tabulām")
    parser.add_argument("--transactions", action="store_true", help="Ielādēt nekustamo īpašumu darījumus (NĪTB)")
    parser.add_argument("--cadastre-riga", action="store_true", help="Ielādēt Rīgas kadastra robežas un būves")
    parser.add_argument("--addresses", action="store_true", help="Ielādēt Valsts adrešu reģistru")
    parser.add_argument("--energy", action="store_true", help="Ielādēt BVKB ēku energosertifikātus")
    parser.add_argument("--pollution", action="store_true", help="Ielādēt VVD piesārņotās un potenciāli piesārņotās vietas")
    parser.add_argument("--all", action="store_true", help="Ielādēt visus pieejamos datus (ieskaitot visu LV kadastru)")
    parser.add_argument("--limit", type=int, default=0, help="Ierobežot ierakstu skaitu (0 = bez limita)")

    args = parser.parse_args()

    if not any([args.cadastre_all, args.cadastre_region, args.resume_from, args.vacuum, args.transactions, args.cadastre_riga, args.addresses, args.energy, args.pollution, args.all]):
        parser.print_help()
        sys.exit(0)

    if args.vacuum:
        vacuum_cadastre_tables()

    if args.all or args.cadastre_all:
        import_cadastre_all_latvia(limit=args.limit, resume_from=args.resume_from, keep_zips=args.keep_zips, force=args.force)
    elif args.cadastre_region:
        import_cadastre_all_latvia(limit=args.limit, region_filter=args.cadastre_region, keep_zips=args.keep_zips, force=args.force)
    elif args.cadastre_riga:
        import_cadastre_riga(limit=args.limit)

    if args.all or args.addresses:
        import_addresses(limit=args.limit)

    if args.all or args.transactions:
        import_transactions(limit=args.limit)

    if args.all or args.energy:
        import_energy_certificates(limit=args.limit)

    if args.all or args.pollution:
        import_pollution_sites(limit=args.limit)

    print("\n🏁 Visi pieprasītie dati veiksmīgi ielādēti un pieejami Martin flīzēs un Go API!")

if __name__ == "__main__":
    main()
