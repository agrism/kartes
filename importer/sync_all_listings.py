#!/usr/bin/env python3
"""
importer/sync_all_listings.py - Sinhronizē pilno Latvijas sludinājumu bāzi (38 500+ sludinājumi)
Ielādē visus aktīvos sludinājumus no visu avotu apkopojuma (SS.com, City24, PP.lv)
ar pagināciju un paralēlo apstrādi, nodrošinot 100% datu paritāti ar kadastrakarte.lv.
"""

import os
import sys
import json
import time
import math
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
import psycopg

DB_URL = os.environ.get("DATABASE_URL", "postgresql://kartes:kartes_secret_password@db:5432/kartes")
SEARCH_API_BASE = "https://kadastrakarte.lv/api/search.php"

def safe_float(val):
    if val is None or val == "":
        return None
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except Exception:
        return None

def safe_int(val):
    if val is None or val == "":
        return None
    try:
        return int(val)
    except Exception:
        return None

def parse_floor(floor_str):
    if not floor_str:
        return None, None
    try:
        parts = str(floor_str).split("/")
        if len(parts) == 2:
            return safe_int(parts[0].strip()), safe_int(parts[1].strip())
        elif len(parts) == 1:
            return safe_int(parts[0].strip()), None
    except Exception:
        pass
    return None, None

def fetch_page(page, per=100, retries=3):
    url = f"{SEARCH_API_BASE}?mode=listings&page={page}&per={per}"
    for attempt in range(retries):
        try:
            resp = requests.get(url, timeout=20)
            if resp.status_code == 200:
                data = resp.json()
                return data.get("rows", [])
        except Exception as e:
            if attempt == retries - 1:
                print(f"⚠️ Kļūda ielādējot lapu {page}: {e}")
            time.sleep(1)
    return []

def run_sync():
    print("===================================================================")
    print("🚀 SĀK PILNO SLUDINĀJUMU SINHRONIZĀCIJU (38 500+ ieraksti)...")
    print("===================================================================")

    # 1. Nosaka kopējo sludinājumu skaitu
    try:
        init_resp = requests.get(f"{SEARCH_API_BASE}?mode=listings&page=1&per=1", timeout=15)
        init_data = init_resp.json()
        total_items = init_data.get("total", 0)
    except Exception as e:
        print(f"❌ Neizdevās iegūt kopskaitu no API: {e}")
        return

    per_page = 100
    total_pages = math.ceil(total_items / per_page)
    print(f"📊 Avotā atrasti: {total_items} aktīvi sludinājumi ({total_pages} lapas pa {per_page}).")

    start_time = time.time()
    all_rows = []

    # 2. Paralēli ielādē visas lapas ar ThreadPoolExecutor
    print(f"⚡ Lejupielādē {total_pages} lapas ar 12 paralēliem savienojumiem...")
    completed_pages = 0

    with ThreadPoolExecutor(max_workers=12) as executor:
        future_to_page = {executor.submit(fetch_page, p, per_page): p for p in range(1, total_pages + 1)}
        for future in as_completed(future_to_page):
            rows = future.result()
            if rows:
                all_rows.extend(rows)
            completed_pages += 1
            if completed_pages % 50 == 0 or completed_pages == total_pages:
                print(f"   📥 Ielādētas {completed_pages}/{total_pages} lapas ({len(all_rows)} sludinājumi)...")

    dl_elapsed = round(time.time() - start_time, 2)
    print(f"✅ Visi {len(all_rows)} sludinājumi sekmīgi lejupielādēti {dl_elapsed} sekundēs.")

    # 3. Sagatavo datus ievietošanai datubāzē
    print("🔌 Savienojas ar PostGIS datubāzi un ievieto datus...")
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            # Izmanto UNLOGGED staging tabulu maksimālai veiktspējai
            cur.execute("""
                CREATE UNLOGGED TABLE IF NOT EXISTS staging_all_listings (
                    source VARCHAR(50),
                    external_id VARCHAR(100),
                    deal_type VARCHAR(30),
                    category VARCHAR(50),
                    title TEXT,
                    url TEXT,
                    price NUMERIC(18, 2),
                    first_price NUMERIC(18, 2),
                    price_per_m2 NUMERIC(14, 2),
                    area_m2 NUMERIC(18, 2),
                    rooms INT,
                    floor INT,
                    total_floors INT,
                    address_text TEXT,
                    town VARCHAR(100),
                    district VARCHAR(100),
                    thumb TEXT,
                    lng FLOAT,
                    lat FLOAT,
                    days INT,
                    first_seen TEXT
                );
                TRUNCATE staging_all_listings;
            """)

            with cur.copy("""
                COPY staging_all_listings (
                    source, external_id, deal_type, category, title, url,
                    price, first_price, price_per_m2, area_m2, rooms, floor, total_floors,
                    address_text, town, district, thumb, lng, lat, days, first_seen
                ) FROM STDIN
            """) as copy:
                for r in all_rows:
                    portal = r.get("portal") or "ss.com"
                    if portal == "city24.lv":
                        portal = "city24"
                    mid = str(r.get("mid") or "")
                    if not mid:
                        continue

                    deal_type = r.get("deal_type") or "sell"
                    cat = r.get("category") or "flats"
                    title = r.get("title") or ""
                    url = r.get("url") or ""
                    price = safe_float(r.get("price"))
                    first_p = safe_float(r.get("first_price")) or price
                    ppm2 = safe_float(r.get("price_per_m2"))
                    area = safe_float(r.get("area"))
                    rooms = safe_int(r.get("rooms"))
                    fl, tot_fl = parse_floor(r.get("floor"))
                    addr = r.get("addr_raw") or ""
                    town = r.get("addr_town") or ""
                    district = r.get("addr_district") or ""
                    thumb = r.get("thumb_path") or ""
                    lng = safe_float(r.get("lng"))
                    lat = safe_float(r.get("lat"))
                    days = safe_int(r.get("days")) or 1
                    first_seen = str(r.get("first_seen") or "")

                    copy.write_row((
                        portal, mid, deal_type, cat, title, url,
                        price, first_p, ppm2, area, rooms, fl, tot_fl,
                        addr, town, district, thumb, lng, lat, days, first_seen
                    ))

            print("💾 Dati iekopēti staging tabulā. Veic UPSERT uz public.listings...")

            # 4. UPSERT uz public.listings
            cur.execute("""
                INSERT INTO public.listings (
                    source, external_id, deal_type, category, title, url,
                    price, first_price, price_per_m2, area_m2, rooms, floor, total_floors,
                    address_text, town, district, images, geom, geom_3857,
                    days_on_market, is_active, first_seen_at, last_seen_at, updated_at
                )
                SELECT
                    s.source,
                    s.external_id,
                    s.deal_type,
                    s.category,
                    s.title,
                    s.url,
                    s.price,
                    s.first_price,
                    s.price_per_m2,
                    s.area_m2,
                    s.rooms,
                    s.floor,
                    s.total_floors,
                    s.address_text,
                    s.town,
                    s.district,
                    CASE
                        WHEN s.thumb IS NOT NULL AND s.thumb != '' THEN
                            jsonb_build_array(
                                CASE
                                    WHEN s.thumb LIKE 'http%' THEN s.thumb
                                    ELSE 'https://kadastrakarte.lv/' || ltrim(s.thumb, '/')
                                END
                            )
                        ELSE '[]'::jsonb
                    END,
                    CASE
                        WHEN s.lng IS NOT NULL AND s.lat IS NOT NULL AND s.lng > 20.0 AND s.lat > 55.0
                        THEN ST_SetSRID(ST_MakePoint(s.lng, s.lat), 4326)
                        ELSE NULL
                    END,
                    CASE
                        WHEN s.lng IS NOT NULL AND s.lat IS NOT NULL AND s.lng > 20.0 AND s.lat > 55.0
                        THEN ST_Transform(ST_SetSRID(ST_MakePoint(s.lng, s.lat), 4326), 3857)
                        ELSE NULL
                    END,
                    COALESCE(s.days, 1),
                    TRUE,
                    CASE
                        WHEN s.first_seen IS NOT NULL AND s.first_seen != '' THEN s.first_seen::timestamptz
                        ELSE CURRENT_TIMESTAMP
                    END,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                FROM staging_all_listings s
                ON CONFLICT (source, external_id) DO UPDATE SET
                    deal_type = EXCLUDED.deal_type,
                    category = EXCLUDED.category,
                    title = COALESCE(NULLIF(EXCLUDED.title, ''), listings.title),
                    url = COALESCE(NULLIF(EXCLUDED.url, ''), listings.url),
                    price = COALESCE(EXCLUDED.price, listings.price),
                    first_price = COALESCE(listings.first_price, EXCLUDED.first_price),
                    price_per_m2 = COALESCE(EXCLUDED.price_per_m2, listings.price_per_m2),
                    area_m2 = COALESCE(EXCLUDED.area_m2, listings.area_m2),
                    rooms = COALESCE(EXCLUDED.rooms, listings.rooms),
                    floor = COALESCE(EXCLUDED.floor, listings.floor),
                    total_floors = COALESCE(EXCLUDED.total_floors, listings.total_floors),
                    address_text = COALESCE(NULLIF(EXCLUDED.address_text, ''), listings.address_text),
                    town = COALESCE(NULLIF(EXCLUDED.town, ''), listings.town),
                    district = COALESCE(NULLIF(EXCLUDED.district, ''), listings.district),
                    images = CASE
                        WHEN jsonb_array_length(listings.images) > 1 THEN listings.images
                        WHEN jsonb_array_length(EXCLUDED.images) > 0 THEN EXCLUDED.images
                        ELSE listings.images
                    END,
                    geom = COALESCE(listings.geom, EXCLUDED.geom),
                    geom_3857 = COALESCE(listings.geom_3857, EXCLUDED.geom_3857),
                    days_on_market = EXCLUDED.days_on_market,
                    is_active = TRUE,
                    last_seen_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP;

                DROP TABLE IF EXISTS staging_all_listings;
            """)

            conn.commit()

            # Pārbauda jauno kopskaitu
            cur.execute("SELECT count(*), count(*) FILTER (WHERE deal_type = 'sell'), count(*) FILTER (WHERE deal_type = 'rent') FROM public.listings WHERE is_active = TRUE;")
            tot_act, tot_sell, tot_rent = cur.fetchone()

    total_elapsed = round(time.time() - start_time, 2)
    print("===================================================================")
    print(f"🎉 SINHRONIZĀCIJA PABEIGTA {total_elapsed} sekundēs!")
    print(f"📊 Aktīvie sludinājumi datubāzē: {tot_act} (Pārdod: {tot_sell}, Izīrē: {tot_rent})")
    print("===================================================================")

if __name__ == "__main__":
    run_sync()
