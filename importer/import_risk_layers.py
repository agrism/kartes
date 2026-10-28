#!/usr/bin/env python3
"""
Valsts reģistru un vides risku slāņu ielādes rīks (Task 4)
Ielādē:
  1. DAP Īpaši aizsargājamās dabas teritorijas & Mikroliegumi (mv_protected_areas)
  2. DAP Dabas pieminekļi / Dižkoki (mv_nature_monuments)
  3. BIS Būvniecības lietas un jaunbūvju dati (construction_cases)
  4. Rīgas / pašvaldību vidi degradējošās būves / grausti (degrading_buildings)
  5. TAPIS Teritorijas funkcionālais zonējums (tapis_zonejums)
  6. ATIS Apgrūtinātās teritorijas & servitūti (way_restrictions)
  7. LVĢMC Plūdu riska zonas (flood_zone_spring_100y, flood_zone_sea_100y)
  8. VMD Meža nogabali (mvr_nogabali, mv_mezi_med)
  9. Darījumu detalizētie skati (mv_tiles_zv, mv_tiles_zvb, mv_tiles_tg)
"""

import os
import sys
import io
import csv
import zipfile
import sqlite3
import argparse
import math
import time
import requests
from tqdm import tqdm
import psycopg
import shapefile
import mapbox_vector_tile
import shapely
from shapely.geometry import shape
import shapely.wkb

DB_URL = os.environ.get("DATABASE_URL", "postgresql://kartes:kartes_secret_password@db:5432/kartes")
CACHE_DIR = os.environ.get("CACHE_DIR", "/app/cache")

URLS = {
    "dap_iadt": "https://data.gov.lv/dati/dataset/b2de2313-c20e-4ebf-a9c0-b8099566320a/resource/aa165932-8835-41a0-baa2-3336d2e8e6ef/download/ipasi_aizsargajamas_dabas_teritorijas.zip",
    "dap_mikroliegumi": "https://data.gov.lv/dati/dataset/fa50b0fb-04f2-452f-ade9-f8448d94eefa/resource/4770cc11-02eb-42e1-98c9-e640e3d8b7ff/download/mikroliegumi.zip",
    "dap_nature": "https://data.gov.lv/dati/dataset/d156b6f2-fd1f-437f-89d9-5c84efd649f3/resource/18139898-7119-4ff8-b769-5ab956209bd3/download/dabas_pieminekli.zip",
    "grausti": "https://data.gov.lv/dati/dataset/9789c471-5751-4b20-87ac-7aba43c42f8b/resource/1eb37edb-091f-476b-8f30-7fb24791a7e5/download/vidi_degradejosas_buves.zip",
    "bis_construction": "https://data.gov.lv/dati/dataset/9833285e-6529-49dc-b5ee-fb8de3881380/resource/10e7b228-845e-4345-b3c7-4d1774e27b85/download/jaunbuvju_geotelpiskie_dati_28.10.2026.csv",
    "tapis_gpkg": "https://data.gov.lv/dati/dataset/f5fa538b-8e2a-4bee-ab64-a9c41937337a/resource/26352840-5766-4a3b-bb85-170ce89fdbc3/download/funkcionalais_zonejums.gpkg",
    "atis_restrictions": "https://data.gov.lv/dati/dataset/f5fa538b-8e2a-4bee-ab64-a9c41937337a/resource/fc983470-de8c-46f6-b28f-080e509e111a/download/apgrutinatas_teritorijas.zip",
}

def download_cached(url: str, filename: str) -> str:
    """Lejupielādē failu kešatmiņā, ja tas vēl nav lejupielādēts."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    dest = os.path.join(CACHE_DIR, filename)
    if os.path.exists(dest) and os.path.getsize(dest) > 1024:
        print(f"📦 Izmanto kešoto failu: {filename} ({os.path.getsize(dest)//1024} KB)")
        return dest
    print(f"⬇️ Lejupielādē: {url}")
    r = requests.get(url, stream=True, timeout=180, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    total = int(r.headers.get("content-length", 0))
    with open(dest, "wb") as f, tqdm(total=total, unit="B", unit_scale=True, desc=filename) as pbar:
        for chunk in r.iter_content(chunk_size=131072):
            if chunk:
                f.write(chunk)
                pbar.update(len(chunk))
    return dest

def import_protected_areas():
    """1. DAP ĪADT un Mikroliegumi (mv_protected_areas)."""
    print("\n--- 🌲 1. DAP ĪADT UN MIKROLIEGUMU IMPORTS ---")
    iadt_zip = download_cached(URLS["dap_iadt"], "ipasi_aizsargajamas_dabas_teritorijas.zip")
    micro_zip = download_cached(URLS["dap_mikroliegumi"], "mikroliegumi.zip")

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS public.mv_protected_areas (
                    id serial PRIMARY KEY,
                    name text,
                    category text,
                    code text,
                    geom geometry(Geometry, 3857)
                );
                TRUNCATE TABLE public.mv_protected_areas;
            """)
            conn.commit()

            total_inserted = 0

            # 1.1 ĪADT pamatteritorijas
            with zipfile.ZipFile(iadt_zip, 'r') as zf:
                for base in ["Ipasi_aizsargajamas_dabas_teritorijas/IADT_pamatteritorijas", "IADT_pamatteritorijas"]:
                    if f"{base}.shp" in zf.namelist():
                        sf = shapefile.Reader(
                            shp=io.BytesIO(zf.read(f"{base}.shp")),
                            shx=io.BytesIO(zf.read(f"{base}.shx")),
                            dbf=io.BytesIO(zf.read(f"{base}.dbf")),
                            encoding="utf-8", encodingErrors="replace"
                        )
                        print(f"📖 Apstrādā ĪADT ({len(sf)} teritorijas)...")
                        batch = []
                        for shape_rec in tqdm(sf.iterShapeRecords(), total=len(sf), desc="ĪADT"):
                            geom_obj = shape_rec.shape.__geo_interface__
                            if not geom_obj or not geom_obj.get("coordinates"):
                                continue
                            rec = shape_rec.record.as_dict()
                            name = str(rec.get("NAME") or rec.get("SITE_NAME") or "Dabas liegums").strip()
                            category = str(rec.get("CATEGORY") or "ĪADT").strip()
                            code = str(rec.get("SITE_CODE") or rec.get("ATIS_CODE") or "").strip()
                            wkb_bytes = shapely.wkb.dumps(shape(geom_obj))
                            batch.append((name, category, code, wkb_bytes))
                            if len(batch) >= 500:
                                cur.executemany("""
                                    INSERT INTO public.mv_protected_areas (name, category, code, geom)
                                    VALUES (%s, %s, %s, ST_Transform(ST_SetSRID(ST_GeomFromWKB(%s), 3059), 3857));
                                """, batch)
                                conn.commit()
                                total_inserted += len(batch)
                                batch.clear()
                        if batch:
                            cur.executemany("""
                                INSERT INTO public.mv_protected_areas (name, category, code, geom)
                                VALUES (%s, %s, %s, ST_Transform(ST_SetSRID(ST_GeomFromWKB(%s), 3059), 3857));
                            """, batch)
                            conn.commit()
                            total_inserted += len(batch)

            # 1.2 Mikroliegumi
            with zipfile.ZipFile(micro_zip, 'r') as zf:
                for base in ["Mikroliegumi/Mikroliegumi", "Mikroliegumi"]:
                    if f"{base}.shp" in zf.namelist():
                        sf = shapefile.Reader(
                            shp=io.BytesIO(zf.read(f"{base}.shp")),
                            shx=io.BytesIO(zf.read(f"{base}.shx")),
                            dbf=io.BytesIO(zf.read(f"{base}.dbf")),
                            encoding="utf-8", encodingErrors="replace"
                        )
                        print(f"📖 Apstrādā Mikroliegumus ({len(sf)} objekti)...")
                        batch = []
                        for shape_rec in tqdm(sf.iterShapeRecords(), total=len(sf), desc="Mikroliegumi"):
                            geom_obj = shape_rec.shape.__geo_interface__
                            if not geom_obj or not geom_obj.get("coordinates"):
                                continue
                            rec = shape_rec.record.as_dict()
                            mrcode = str(rec.get("MRCODE") or "").strip()
                            name = f"Mikroliegums #{mrcode}" if mrcode else "Mikroliegums"
                            category = "Mikroliegums"
                            code = str(rec.get("ATIS_CODE") or mrcode).strip()
                            wkb_bytes = shapely.wkb.dumps(shape(geom_obj))
                            batch.append((name, category, code, wkb_bytes))
                            if len(batch) >= 500:
                                cur.executemany("""
                                    INSERT INTO public.mv_protected_areas (name, category, code, geom)
                                    VALUES (%s, %s, %s, ST_Transform(ST_SetSRID(ST_GeomFromWKB(%s), 3059), 3857));
                                """, batch)
                                conn.commit()
                                total_inserted += len(batch)
                                batch.clear()
                        if batch:
                            cur.executemany("""
                                INSERT INTO public.mv_protected_areas (name, category, code, geom)
                                VALUES (%s, %s, %s, ST_Transform(ST_SetSRID(ST_GeomFromWKB(%s), 3059), 3857));
                            """, batch)
                            conn.commit()
                            total_inserted += len(batch)

            print("🔨 Veido telpisko indeksu 'idx_mv_protected_areas_geom'...")
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_mv_protected_areas_geom ON public.mv_protected_areas USING GIST (geom);
                ANALYZE public.mv_protected_areas;
            """)
            conn.commit()
            print(f"✅ Ielādētas {total_inserted} aizsargājamās dabas teritorijas un mikroliegumi!")

def import_nature_monuments():
    """2. DAP Dabas pieminekļi un dižkoki (mv_nature_monuments)."""
    print("\n--- 🌳 2. DAP DABAS PIEMINEKĻU & DIŽKOKU IMPORTS ---")
    nature_zip = download_cached(URLS["dap_nature"], "dabas_pieminekli.zip")

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS public.mv_nature_monuments (
                    id serial PRIMARY KEY,
                    name text,
                    category text,
                    geom geometry(Point, 3857)
                );
                TRUNCATE TABLE public.mv_nature_monuments;
            """)
            conn.commit()

            total_inserted = 0
            with zipfile.ZipFile(nature_zip, 'r') as zf:
                for base in ["Dabas_pieminekli/IADT_dabas_pieminekli", "IADT_dabas_pieminekli"]:
                    if f"{base}.shp" in zf.namelist():
                        sf = shapefile.Reader(
                            shp=io.BytesIO(zf.read(f"{base}.shp")),
                            shx=io.BytesIO(zf.read(f"{base}.shx")),
                            dbf=io.BytesIO(zf.read(f"{base}.dbf")),
                            encoding="utf-8", encodingErrors="replace"
                        )
                        print(f"📖 Apstrādā dabas pieminekļus ({len(sf)} punkti)...")
                        batch = []
                        for shape_rec in tqdm(sf.iterShapeRecords(), total=len(sf), desc="Dabas pieminekļi"):
                            pts = shape_rec.shape.points
                            if not pts:
                                continue
                            pt_x, pt_y = pts[0][0], pts[0][1]
                            rec = shape_rec.record.as_dict()
                            species = str(rec.get("SPECIES_LV") or rec.get("LOCALNAME") or "Dižkoks").strip()
                            circumf = rec.get("CIRCUMF_1_")
                            height = rec.get("HEIGHT")
                            details = []
                            if circumf: details.append(f"apkārtmērs {circumf}m")
                            if height: details.append(f"augstums {height}m")
                            desc = f"{species} ({', '.join(details)})" if details else species
                            cat = str(rec.get("CATEGORY") or "Dabas piemineklis").strip()
                            point_wkt = f"SRID=3059;POINT({pt_x} {pt_y})"
                            batch.append((desc, cat, point_wkt))
                            if len(batch) >= 1000:
                                cur.executemany("""
                                    INSERT INTO public.mv_nature_monuments (name, category, geom)
                                    VALUES (%s, %s, ST_Transform(ST_GeomFromEWKT(%s), 3857));
                                """, batch)
                                conn.commit()
                                total_inserted += len(batch)
                                batch.clear()
                        if batch:
                            cur.executemany("""
                                INSERT INTO public.mv_nature_monuments (name, category, geom)
                                VALUES (%s, %s, ST_Transform(ST_GeomFromEWKT(%s), 3857));
                            """, batch)
                            conn.commit()
                            total_inserted += len(batch)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_mv_nature_monuments_geom ON public.mv_nature_monuments USING GIST (geom);
                ANALYZE public.mv_nature_monuments;
            """)
            conn.commit()
            print(f"✅ Ielādēti {total_inserted} dabas pieminekļi un dižkoki!")

def import_degrading_buildings():
    """3. Vidi degradējošās būves / Grausti (degrading_buildings)."""
    print("\n--- 🏚️ 3. VIDI DEGRADĒJOŠO BŪVJU (GRAUSTU) IMPORTS ---")
    grausti_zip = download_cached(URLS["grausti"], "vidi_degradejosas_buves.zip")

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS public.degrading_buildings (
                    id serial PRIMARY KEY,
                    address text,
                    status text,
                    cadastre_code varchar(14),
                    geom geometry(Geometry, 3857)
                );
                TRUNCATE TABLE public.degrading_buildings;
            """)
            conn.commit()

            total_inserted = 0
            with zipfile.ZipFile(grausti_zip, 'r') as zf:
                sf = shapefile.Reader(
                    shp=io.BytesIO(zf.read("vidi_degradejosas_buves.shp")),
                    shx=io.BytesIO(zf.read("vidi_degradejosas_buves.shx")),
                    dbf=io.BytesIO(zf.read("vidi_degradejosas_buves.dbf")),
                    encoding="windows-1257", encodingErrors="replace"
                )
                print(f"📖 Apstrādā degradējošās būves ({len(sf)} objekti)...")
                batch = []
                for shape_rec in tqdm(sf.iterShapeRecords(), total=len(sf), desc="Grausti"):
                    geom_obj = shape_rec.shape.__geo_interface__
                    if not geom_obj or not geom_obj.get("coordinates"):
                        continue
                    rec = shape_rec.record.as_dict()
                    addr = str(rec.get("adrese") or "").strip()
                    status = str(rec.get("statuss") or "Grausts").strip()
                    cad = str(rec.get("cadastrena") or "").strip()
                    wkb_bytes = shapely.wkb.dumps(shape(geom_obj))
                    batch.append((addr, status, cad, wkb_bytes))
                    if len(batch) >= 500:
                        cur.executemany("""
                            INSERT INTO public.degrading_buildings (address, status, cadastre_code, geom)
                            VALUES (%s, %s, %s, ST_Transform(ST_SetSRID(ST_GeomFromWKB(%s), 3059), 3857));
                        """, batch)
                        conn.commit()
                        total_inserted += len(batch)
                        batch.clear()
                if batch:
                    cur.executemany("""
                        INSERT INTO public.degrading_buildings (address, status, cadastre_code, geom)
                        VALUES (%s, %s, %s, ST_Transform(ST_SetSRID(ST_GeomFromWKB(%s), 3059), 3857));
                    """, batch)
                    conn.commit()
                    total_inserted += len(batch)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_degrading_buildings_geom ON public.degrading_buildings USING GIST (geom);
                ANALYZE public.degrading_buildings;
            """)
            conn.commit()
            print(f"✅ Ielādētas {total_inserted} degradētās ēkas!")

def import_construction_cases():
    """4. BIS Būvniecības lietas un ieceres (construction_cases)."""
    print("\n--- 🏗️ 4. BIS BŪVNIECĪBAS IECERU & LIETU IMPORTS ---")
    csv_path = download_cached(URLS["bis_construction"], "jaunbuvju_geotelpiskie_dati.csv")

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS public.construction_cases (
                    id serial PRIMARY KEY,
                    name text,
                    case_number text,
                    building_code varchar(14),
                    address text,
                    geom geometry(Geometry, 3857)
                );
                TRUNCATE TABLE public.construction_cases;
            """)
            conn.commit()

            total_inserted = 0
            batch = []
            with open(csv_path, 'r', encoding='utf-8-sig', errors='ignore') as f:
                reader = csv.DictReader(f)
                for row in tqdm(reader, desc="BIS Jaunbūves"):
                    lon_str = (row.get("Buves_atrasanas_vieta_geografiskais_garums") or "").replace(",", ".").strip()
                    lat_str = (row.get("Buves_atrasanas_vieta_geografiskais_platums") or "").replace(",", ".").strip()
                    if not lon_str or not lat_str:
                        continue
                    try:
                        lon = float(lon_str)
                        lat = float(lat_str)
                        if not (20.5 <= lon <= 28.5 and 55.5 <= lat <= 58.5):
                            continue
                    except Exception:
                        continue
                    name = (row.get("Buves_nosaukums") or row.get("Planotais_buves_galvenais_lietosanas_veids") or "Būvniecības iecere").strip()
                    case_num = (row.get("Buvniecibas_lietas_numurs") or "").strip()
                    b_code = (row.get("Buves_kadastra_apzimejums") or "").strip()[:14]
                    addr = (row.get("Buves_adreses_teksts") or "").strip()

                    batch.append((name, case_num, b_code, addr, lon, lat))
                    if len(batch) >= 1000:
                        cur.executemany("""
                            INSERT INTO public.construction_cases (name, case_number, building_code, address, geom)
                            VALUES (%s, %s, %s, %s, ST_Buffer(ST_Transform(ST_SetSRID(ST_Point(%s, %s), 4326), 3857), 15));
                        """, batch)
                        conn.commit()
                        total_inserted += len(batch)
                        batch.clear()

                if batch:
                    cur.executemany("""
                        INSERT INTO public.construction_cases (name, case_number, building_code, address, geom)
                        VALUES (%s, %s, %s, %s, ST_Buffer(ST_Transform(ST_SetSRID(ST_Point(%s, %s), 4326), 3857), 15));
                    """, batch)
                    conn.commit()
                    total_inserted += len(batch)

            print("📍 Sasaista būvniecības lietas ar precīzajām ēku kontūrām no 'buildings'...")
            cur.execute("""
                UPDATE public.construction_cases c
                SET geom = ST_Buffer(b.geom, 2)
                FROM public.buildings b
                WHERE c.building_code = b.code AND c.building_code != '';

                CREATE INDEX IF NOT EXISTS idx_construction_cases_geom ON public.construction_cases USING GIST (geom);
                ANALYZE public.construction_cases;
            """)
            conn.commit()
            print(f"✅ Ielādētas {total_inserted} būvniecības ieceres!")

def import_tapis_zoning():
    """5. TAPIS Teritorijas funkcionālais zonējums (tapis_zonejums)."""
    print("\n--- 🗺️ 5. TAPIS TERITORIJAS PLĀNOJUMA ZONĒJUMA IMPORTS ---")
    gpkg_path = download_cached(URLS["tapis_gpkg"], "funkcionalais_zonejums.gpkg")

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS public.tapis_zonejums (
                    id serial PRIMARY KEY,
                    indekss text,
                    nosaukums text,
                    geom geometry(Geometry, 3857)
                );
                TRUNCATE TABLE public.tapis_zonejums;
            """)
            conn.commit()

            sqlite_conn = sqlite3.connect(gpkg_path)
            c = sqlite_conn.cursor()
            c.execute("SELECT planotais_, stāvi, vairak_inf, geom FROM funkcionalais_zonejums;")
            
            total_inserted = 0
            batch = []
            for row in tqdm(c.fetchall(), desc="TAPIS zonējums"):
                indekss = (row[0] or "").strip()
                stavi = (row[1] or "").strip()
                vairak = (row[2] or "").strip()
                name_parts = [p for p in [indekss, stavi, vairak] if p]
                nosaukums = " - ".join(name_parts) if name_parts else "Funkcionālā zona"
                raw_geom = row[3]
                if not raw_geom:
                    continue
                # GeoPackage WKB header starts at byte 8 (header length 8 + flags)
                # GPKG geometry has standard header: [0..1] magic, [2] flags, [3..7] srs_id
                header_len = 8
                flags = raw_geom[3] if len(raw_geom) > 3 else 0
                envelope_indicator = (flags >> 1) & 0x07
                if envelope_indicator == 1: header_len += 32
                elif envelope_indicator in (2, 3): header_len += 48
                elif envelope_indicator == 4: header_len += 64
                wkb_payload = raw_geom[header_len:]

                batch.append((indekss, nosaukums, wkb_payload))
                if len(batch) >= 500:
                    cur.executemany("""
                        INSERT INTO public.tapis_zonejums (indekss, nosaukums, geom)
                        VALUES (%s, %s, ST_Transform(ST_SetSRID(ST_GeomFromWKB(%s), 3059), 3857));
                    """, batch)
                    conn.commit()
                    total_inserted += len(batch)
                    batch.clear()

            if batch:
                cur.executemany("""
                    INSERT INTO public.tapis_zonejums (indekss, nosaukums, geom)
                    VALUES (%s, %s, ST_Transform(ST_SetSRID(ST_GeomFromWKB(%s), 3059), 3857));
                """, batch)
                conn.commit()
                total_inserted += len(batch)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_tapis_zonejums_geom ON public.tapis_zonejums USING GIST (geom);
                ANALYZE public.tapis_zonejums;
            """)
            conn.commit()
            print(f"✅ Ielādētas {total_inserted} TAPIS funkcionālās zonas!")

def import_way_restrictions():
    """6. ATIS Apgrūtinājumi un ceļu servitūti (way_restrictions)."""
    print("\n--- 🚧 6. ATIS CEĻU SERVITŪTU & APGRŪTINĀJUMU IMPORTS ---")
    atis_zip = download_cached(URLS["atis_restrictions"], "apgrutinatas_teritorijas.zip")

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS public.way_restrictions (
                    id serial PRIMARY KEY,
                    name text,
                    code text,
                    geom geometry(Geometry, 3857)
                );
                TRUNCATE TABLE public.way_restrictions;
            """)
            conn.commit()

            total_inserted = 0
            with zipfile.ZipFile(atis_zip, 'r') as zf:
                sf = shapefile.Reader(
                    shp=io.BytesIO(zf.read("apgrutinatas_teritorijas.shp")),
                    shx=io.BytesIO(zf.read("apgrutinatas_teritorijas.shx")),
                    dbf=io.BytesIO(zf.read("apgrutinatas_teritorijas.dbf")),
                    encoding="utf-8", encodingErrors="replace"
                )
                print(f"📖 Apstrādā apgrūtinātās teritorijas ({len(sf)} objekti)...")
                batch = []
                for shape_rec in tqdm(sf.iterShapeRecords(), total=len(sf), desc="Servitūti"):
                    geom_obj = shape_rec.shape.__geo_interface__
                    if not geom_obj or not geom_obj.get("coordinates"):
                        continue
                    rec = shape_rec.record.as_dict()
                    name = str(rec.get("apzimejums") or rec.get("nosaukums") or "Ceļu servitūts").strip()
                    code = str(rec.get("kods") or "").strip()
                    wkb_bytes = shapely.wkb.dumps(shape(geom_obj))
                    batch.append((name, code, wkb_bytes))
                    if len(batch) >= 500:
                        cur.executemany("""
                            INSERT INTO public.way_restrictions (name, code, geom)
                            VALUES (%s, %s, ST_Transform(ST_SetSRID(ST_GeomFromWKB(%s), 3059), 3857));
                        """, batch)
                        conn.commit()
                        total_inserted += len(batch)
                        batch.clear()

                if batch:
                    cur.executemany("""
                        INSERT INTO public.way_restrictions (name, code, geom)
                        VALUES (%s, %s, ST_Transform(ST_SetSRID(ST_GeomFromWKB(%s), 3059), 3857));
                    """, batch)
                    conn.commit()
                    total_inserted += len(batch)

            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_way_restrictions_geom ON public.way_restrictions USING GIST (geom);
                ANALYZE public.way_restrictions;
            """)
            conn.commit()
            print(f"✅ Ielādēti {total_inserted} ceļu servitūti un apgrūtinājumi!")

def create_transaction_views():
    """7. Izveido darījumu detalizētos skatus (mv_tiles_zv, mv_tiles_zvb, mv_tiles_tg)."""
    print("\n--- 💼 7. DARĪJUMU FLĪŽU SKATU IZVEIDE (POSTGIS) ---")
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE OR REPLACE VIEW public.mv_tiles_zv AS
                SELECT
                    id,
                    cadastre_code AS zv_kods,
                    amount_eur AS summa,
                    to_char(deal_date, 'YYYY-MM-DD') AS datums,
                    address AS adrese,
                    geom
                FROM public.transactions
                WHERE property_type = 'zv' OR property_type = 'Zeme' OR property_type IS NULL;

                CREATE OR REPLACE VIEW public.mv_tiles_zvb AS
                SELECT
                    id,
                    cadastre_code AS zv_kods,
                    amount_eur AS summa,
                    to_char(deal_date, 'YYYY-MM-DD') AS datums,
                    address AS adrese,
                    geom
                FROM public.transactions
                WHERE property_type = 'zvb' OR property_type = 'Būve un zeme' OR property_type = 'Zeme ar būvi';

                CREATE OR REPLACE VIEW public.mv_tiles_tg AS
                SELECT
                    id,
                    cadastre_code AS zv_kods,
                    amount_eur AS summa,
                    to_char(deal_date, 'YYYY-MM-DD') AS datums,
                    address AS adrese,
                    geom
                FROM public.transactions
                WHERE property_type = 'tg' OR property_type = 'Telpu grupa';
            """)
            conn.commit()
            print("✅ Izveidoti skati: public.mv_tiles_zv, public.mv_tiles_zvb, public.mv_tiles_tg!")

def deg2num(lat_deg, lon_deg, zoom):
    lat_rad = math.radians(lat_deg)
    n = 2.0 ** zoom
    xtile = int((lon_deg + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return (xtile, ytile)

def make_tile_transformer(z, x, y, extent=4096.0):
    delta = 40075016.68557849 / (2 ** z)
    x_orig = -20037508.342789244 + x * delta
    y_orig = 20037508.342789244 - y * delta
    def tf(coords):
        res = coords.copy()
        res[:, 0] = x_orig + (coords[:, 0] / extent) * delta
        res[:, 1] = y_orig - (coords[:, 1] / extent) * delta
        return res
    return tf

def import_flood_zones():
    """8. LVĢMC Plūdu riska zonas (flood_zone_spring_100y & flood_zone_sea_100y)."""
    print("\n--- 🌊 8. LVĢMC PLŪDU RISKA ZONU IMPORTS (100 GADU PLŪDI) ---")
    layers = [
        ("flood_zone_spring_100y", "Pavasara plūdi (1% varbūtība)"),
        ("flood_zone_sea_100y", "Jūras vējuzplūdi (1% varbūtība)")
    ]

    z = 8
    x1, y2 = deg2num(55.67, 20.93, z)
    x2, y1 = deg2num(58.09, 28.24, z)

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            for tbl, desc_name in layers:
                cur.execute(f"""
                    CREATE TABLE IF NOT EXISTS public.{tbl} (
                        id serial PRIMARY KEY,
                        name text,
                        geom geometry(Geometry, 3857)
                    );
                    TRUNCATE TABLE public.{tbl};
                """)
                conn.commit()

                print(f"📖 Ielādē {desc_name} ({tbl})...")
                total_inserted = 0
                batch = []

                for x in range(x1, x2 + 1):
                    for y in range(y1, y2 + 1):
                        url = f"https://kadastrakarte.lv/tiles/{tbl}/{z}/{x}/{y}"
                        req = requests.Request("GET", url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://kadastrakarte.lv/"}).prepare()
                        try:
                            with requests.Session() as s:
                                resp = s.send(req, timeout=5)
                                if resp.status_code == 200 and resp.content:
                                    decoded = mapbox_vector_tile.decode(resp.content)
                                    features = decoded.get(tbl, {}).get("features", [])
                                    if features:
                                        tf = make_tile_transformer(z, x, y)
                                        for f in features:
                                            g = shape(f["geometry"])
                                            if not g.is_valid:
                                                g = g.buffer(0)
                                            poly_3857 = shapely.transform(g, tf)
                                            wkb = shapely.wkb.dumps(poly_3857)
                                            name = f.get("properties", {}).get("name") or desc_name
                                            batch.append((name, wkb))

                                            if len(batch) >= 500:
                                                cur.executemany(f"""
                                                    INSERT INTO public.{tbl} (name, geom)
                                                    VALUES (%s, ST_SetSRID(ST_GeomFromWKB(%s), 3857));
                                                """, batch)
                                                conn.commit()
                                                total_inserted += len(batch)
                                                batch.clear()
                        except Exception:
                            pass
                        time.sleep(0.01)

                if batch:
                    cur.executemany(f"""
                        INSERT INTO public.{tbl} (name, geom)
                        VALUES (%s, ST_SetSRID(ST_GeomFromWKB(%s), 3857));
                    """, batch)
                    conn.commit()
                    total_inserted += len(batch)

                cur.execute(f"""
                    CREATE INDEX IF NOT EXISTS idx_{tbl}_geom ON public.{tbl} USING GIST (geom);
                    ANALYZE public.{tbl};
                """)
                conn.commit()
                print(f"✅ Ielādēti {total_inserted} {desc_name} poligoni tabulā '{tbl}'!")

def import_forest_layers():
    """9. VMD Meža valsts reģistrs (mv_mezi_med & mvr_nogabali)."""
    print("\n--- 🌲 9. VMD MEŽA VALSTS REĢISTRA IMPORTS (NOGABALI) ---")
    z = 9
    x1, y2 = deg2num(55.67, 20.93, z)
    x2, y1 = deg2num(58.09, 28.24, z)

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS public.mv_mezi_med (
                    id serial PRIMARY KEY,
                    name text,
                    geom geometry(Geometry, 3857)
                );
                TRUNCATE TABLE public.mv_mezi_med;
            """)
            conn.commit()

            print(f"📖 Ielādē meža nogabalus no z={z} (96 flīzes)...")
            total_inserted = 0
            batch = []

            for x in range(x1, x2 + 1):
                for y in range(y1, y2 + 1):
                    url = f"https://kadastrakarte.lv/tiles/mv_mezi_med/{z}/{x}/{y}"
                    try:
                        resp = requests.get(url, timeout=5, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://kadastrakarte.lv/"})
                        if resp.status_code == 200 and resp.content:
                            decoded = mapbox_vector_tile.decode(resp.content)
                            features = decoded.get("mv_mezi_med", {}).get("features", [])
                            if features:
                                tf = make_tile_transformer(z, x, y)
                                for f in features:
                                    g = shape(f["geometry"])
                                    if not g.is_valid:
                                        g = g.buffer(0)
                                    poly_3857 = shapely.transform(g, tf)
                                    wkb = shapely.wkb.dumps(poly_3857)
                                    batch.append(("Meža nogabals", wkb))

                                    if len(batch) >= 1000:
                                        cur.executemany("""
                                            INSERT INTO public.mv_mezi_med (name, geom)
                                            VALUES (%s, ST_SetSRID(ST_GeomFromWKB(%s), 3857));
                                        """, batch)
                                        conn.commit()
                                        total_inserted += len(batch)
                                        batch.clear()
                    except Exception:
                        pass
                    time.sleep(0.01)

            if batch:
                cur.executemany("""
                    INSERT INTO public.mv_mezi_med (name, geom)
                    VALUES (%s, ST_SetSRID(ST_GeomFromWKB(%s), 3857));
                """, batch)
                conn.commit()
                total_inserted += len(batch)

            print("🔨 Veido telpisko indeksu 'idx_mezi_med_geom' un skatu 'mvr_nogabali'...")
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_mezi_med_geom ON public.mv_mezi_med USING GIST (geom);
                ANALYZE public.mv_mezi_med;

                DROP TABLE IF EXISTS public.mvr_nogabali CASCADE;
                DROP VIEW IF EXISTS public.mvr_nogabali CASCADE;
                CREATE OR REPLACE VIEW public.mvr_nogabali AS
                SELECT id, name, geom FROM public.mv_mezi_med;
            """)
            conn.commit()
            print(f"✅ Ielādēti {total_inserted} meža nogabali un sagatavots 'mvr_nogabali' skats!")

def ensure_risk_tables():
    """Nodrošina, ka visas bāzes tabulas un skati eksistē."""
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS public.flood_zone_spring_100y (
                    id serial PRIMARY KEY,
                    name text,
                    geom geometry(Geometry, 3857)
                );
                CREATE TABLE IF NOT EXISTS public.flood_zone_sea_100y (
                    id serial PRIMARY KEY,
                    name text,
                    geom geometry(Geometry, 3857)
                );
                CREATE TABLE IF NOT EXISTS public.mv_mezi_med (
                    id serial PRIMARY KEY,
                    name text,
                    geom geometry(Geometry, 3857)
                );
            """)
            conn.commit()

def main():
    parser = argparse.ArgumentParser(description="Valsts reģistru un vides risku slāņu integrācijas rīks")
    parser.add_argument("--all", action="store_true", help="Ielādēt visus risku un reģistru slāņus")
    parser.add_argument("--protected", action="store_true", help="DAP ĪADT un mikroliegumi")
    parser.add_argument("--nature", action="store_true", help="DAP dabas pieminekļi un dižkoki")
    parser.add_argument("--grausti", action="store_true", help="Vidi degradējošās būves")
    parser.add_argument("--construction", action="store_true", help="BIS būvniecības lietas")
    parser.add_argument("--tapis", action="store_true", help="TAPIS funkcionālais zonējums")
    parser.add_argument("--restrictions", action="store_true", help="ATIS apgrūtinājumi un servitūti")
    parser.add_argument("--views", action="store_true", help="Darījumu detalizētie skati")
    parser.add_argument("--floods", action="store_true", help="LVĢMC plūdu riska zonas")
    parser.add_argument("--forests", action="store_true", help="VMD meža nogabali")
    args = parser.parse_args()

    ensure_risk_tables()

    if args.all or args.views:
        create_transaction_views()
    if args.all or args.protected:
        import_protected_areas()
    if args.all or args.nature:
        import_nature_monuments()
    if args.all or args.grausti:
        import_degrading_buildings()
    if args.all or args.construction:
        import_construction_cases()
    if args.all or args.tapis:
        import_tapis_zoning()
    if args.all or args.restrictions:
        import_way_restrictions()
    if args.all or args.floods:
        import_flood_zones()
    if args.all or args.forests:
        import_forest_layers()

    if not any(vars(args).values()):
        parser.print_help()

if __name__ == "__main__":
    main()
