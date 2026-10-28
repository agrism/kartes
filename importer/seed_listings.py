#!/usr/bin/env python3
"""
seed_listings.py - Sākotnējā sludinājumu un vēstures datu ielāde
Ielādē aktīvos sludinājumus, piesaista pie kadastra zemes vienībām un saglabā cenu izmaiņu vēsturi.
"""

import os
import sys
import json
import time
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
import psycopg

DB_URL = os.environ.get("DATABASE_URL", "postgresql://kartes:kartes_secret_password@db:5432/kartes")
LISTINGS_GEOJSON_URL = "https://kadastrakarte.lv/api/listings-geojson.php?portal=ss.com&bbox=20.9,55.6,28.3,58.1"
LISTING_HISTORY_URL = "https://kadastrakarte.lv/api/listing-history.php"

def safe_float(val, max_val=1e12):
    if val is None or val == "":
        return None
    try:
        f = float(val)
        if f > max_val or f < -max_val:
            return None
        return f
    except Exception:
        return None

def safe_int(val, max_val=2147483647):
    if val is None or val == "":
        return None
    try:
        i = int(val)
        if i > max_val or i < -max_val:
            return None
        return i
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

def seed_initial_listings():
    print(f"📥 1. Lejupielādē Latvijas sludinājumu GeoJSON no {LISTINGS_GEOJSON_URL}...")
    resp = requests.get(LISTINGS_GEOJSON_URL, timeout=60)
    resp.raise_for_status()
    data = resp.json()

    features = data.get("features", [])
    total_count = len(features)
    print(f"✅ Saņemti {total_count} sludinājumi.")

    print(f"🔌 Savienojas ar datubāzi...")
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            # Batch ievietošana unlogged pagaidu tabulā
            print("🚀 Sagatavo un ievieto sludinājumu pamatdatus...")
            cur.execute("""
                CREATE UNLOGGED TABLE IF NOT EXISTS staging_listings (
                    source VARCHAR(50),
                    external_id VARCHAR(100),
                    deal_type VARCHAR(30),
                    category VARCHAR(50),
                    title TEXT,
                    description TEXT,
                    url TEXT,
                    price NUMERIC(18, 2),
                    price_per_m2 NUMERIC(14, 2),
                    area_m2 NUMERIC(18, 2),
                    rooms INT,
                    floor INT,
                    total_floors INT,
                    series VARCHAR(50),
                    address_text TEXT,
                    town VARCHAR(100),
                    district VARCHAR(100),
                    thumb TEXT,
                    lng FLOAT,
                    lat FLOAT,
                    has_drop BOOLEAN
                );
                TRUNCATE staging_listings;
            """)

            with cur.copy("""
                COPY staging_listings (
                    source, external_id, deal_type, category, title, description,
                    url, price, price_per_m2, area_m2, rooms, floor, total_floors,
                    series, address_text, town, district, thumb, lng, lat, has_drop
                ) FROM STDIN
            """) as copy:
                for f in features:
                    props = f.get("properties", {})
                    geom = f.get("geometry", {})
                    coords = geom.get("coordinates") if geom else None
                    if not coords or len(coords) < 2:
                        continue
                    lng, lat = coords[0], coords[1]
                    fl, tot_fl = parse_floor(props.get("floor"))

                    copy.write_row((
                        props.get("portal") or "ss.com",
                        str(props.get("mid") or ""),
                        props.get("deal_type") or "sell",
                        props.get("category") or "flats",
                        props.get("snippet") or "",
                        props.get("snippet") or "",
                        props.get("url") or "",
                        safe_float(props.get("price")),
                        safe_float(props.get("price_per_m2")),
                        safe_float(props.get("area")),
                        safe_int(props.get("rooms")),
                        fl,
                        tot_fl,
                        props.get("series"),
                        props.get("addr"),
                        props.get("town"),
                        props.get("district"),
                        props.get("thumb") or "",
                        lng,
                        lat,
                        bool(props.get("drop"))
                    ))

            conn.commit()

            print("💾 Veic sinhronizāciju ar 'public.listings' tabulu...")
            cur.execute("""
                INSERT INTO public.listings (
                    source, external_id, deal_type, category, title, description,
                    url, price, first_price, price_per_m2, area_m2, rooms, floor, total_floors,
                    series, address_text, town, district, images, geom, geom_3857, is_active
                )
                SELECT DISTINCT ON (s.source, s.external_id)
                    s.source,
                    s.external_id,
                    s.deal_type,
                    s.category,
                    s.title,
                    s.description,
                    s.url,
                    s.price,
                    s.price,
                    s.price_per_m2,
                    s.area_m2,
                    s.rooms,
                    s.floor,
                    s.total_floors,
                    s.series,
                    s.address_text,
                    s.town,
                    s.district,
                    CASE WHEN s.thumb != '' THEN jsonb_build_array(s.thumb) ELSE '[]'::jsonb END,
                    ST_SetSRID(ST_MakePoint(s.lng, s.lat), 4326),
                    ST_Transform(ST_SetSRID(ST_MakePoint(s.lng, s.lat), 4326), 3857),
                    TRUE
                FROM staging_listings s
                ORDER BY s.source, s.external_id, s.price DESC NULLS LAST
                ON CONFLICT (source, external_id) DO UPDATE SET
                    price = EXCLUDED.price,
                    price_per_m2 = EXCLUDED.price_per_m2,
                    area_m2 = EXCLUDED.area_m2,
                    rooms = EXCLUDED.rooms,
                    address_text = EXCLUDED.address_text,
                    town = EXCLUDED.town,
                    district = EXCLUDED.district,
                    geom = EXCLUDED.geom,
                    geom_3857 = EXCLUDED.geom_3857,
                    is_active = TRUE,
                    last_seen_at = CURRENT_TIMESTAMP;
            """)
            conn.commit()

            print("📍 2. Telpiski piesaista sludinājumus kadastra zemes vienībām...")
            cur.execute("""
                UPDATE public.listings l
                SET cadastre_code = p.code
                FROM public.parcels p
                WHERE l.geom_3857 IS NOT NULL 
                  AND l.cadastre_code IS NULL
                  AND p.geom && l.geom_3857
                  AND ST_Contains(p.geom, l.geom_3857);
            """)
            matched_cadastre = cur.rowcount
            print(f"✅ Kadastram piesaistīti {matched_cadastre} sludinājumi!")
            conn.commit()

            # Atlasa sludinājumus cenu vēstures papildināšanai (ar cenu kritumiem)
            cur.execute("""
                SELECT l.id, l.source, l.external_id 
                FROM public.listings l
                JOIN staging_listings s ON l.source = s.source AND l.external_id = s.external_id
                WHERE s.has_drop = TRUE;
            """)
            drop_candidates = cur.fetchall()
            print(f"📊 3. Atrasti {len(drop_candidates)} sludinājumi ar cenu kritumiem vēstures ielādei.")

    if drop_candidates:
        fetch_and_save_histories(drop_candidates)

    print("🏁 Sākotnējais sludinājumu un vēstures imports pabeigts veiksmīgi!")

def fetch_single_history(item):
    lid, source, mid = item
    try:
        url = f"{LISTING_HISTORY_URL}?portal={source}&mid={mid}"
        r = requests.get(url, timeout=12)
        if r.status_code == 200:
            data = r.json()
            if data.get("ok"):
                return lid, data
    except Exception as e:
        pass
    return lid, None

def fetch_and_save_histories(candidates):
    print(f"⚡ Paralēli ielādē cenu vēsturi ar 15 pavedieniem...")
    results = []
    total = len(candidates)
    done = 0

    with ThreadPoolExecutor(max_workers=15) as executor:
        futures = {executor.submit(fetch_single_history, item): item for item in candidates}
        for future in as_completed(futures):
            lid, data = future.result()
            done += 1
            if data:
                results.append((lid, data))
            if done % 200 == 0 or done == total:
                print(f"  Progres: {done}/{total} ({len(results)} veiksmīgi saņemti)")

    print(f"💾 Saglabā {len(results)} sludinājumu cenu izmaiņas un bildes datubāzē...")
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            for lid, hist in results:
                days = hist.get("days") or 1
                first_price = hist.get("first_price")
                last_price = hist.get("last_price")
                since = hist.get("since")
                images = hist.get("images") or []
                changes = hist.get("changes") or []

                pub_at = None
                if since:
                    try:
                        pub_at = datetime.strptime(since, "%Y-%m-%d")
                    except Exception:
                        pass

                # Atjauno listing pamata ierakstu
                cur.execute("""
                    UPDATE public.listings
                    SET days_on_market = %s,
                        first_price = COALESCE(%s, first_price),
                        price = COALESCE(%s, price),
                        published_at = COALESCE(%s, published_at),
                        images = CASE WHEN %s::jsonb != '[]'::jsonb THEN %s::jsonb ELSE images END
                    WHERE id = %s;
                """, (days, first_price, last_price, pub_at, json.dumps(images), json.dumps(images), lid))

                # Dzēš iepriekšējās izmaiņas šim sludinājumam, ja tādas bija
                cur.execute("DELETE FROM public.listing_price_changes WHERE listing_id = %s;", (lid,))

                # Ievieto vēsturiskās izmaiņas
                prev_price = first_price
                for ch in changes:
                    ch_date_str = ch.get("date")
                    ch_price = ch.get("price")
                    if not ch_date_str or ch_price is None:
                        continue
                    try:
                        ch_date = datetime.strptime(ch_date_str, "%Y-%m-%d").date()
                    except Exception:
                        continue

                    old_pr = prev_price if prev_price is not None else ch_price
                    new_pr = ch_price
                    delta_amt = new_pr - old_pr
                    delta_pct = (delta_amt / old_pr * 100.0) if old_pr and old_pr > 0 else 0.0

                    if delta_amt != 0:
                        cur.execute("""
                            INSERT INTO public.listing_price_changes (
                                listing_id, change_date, old_price, new_price, delta_amount, delta_percent
                            ) VALUES (%s, %s, %s, %s, %s, %s);
                        """, (lid, ch_date, old_pr, new_pr, delta_amt, round(delta_pct, 2)))

                    prev_price = ch_price

        conn.commit()
    print("✅ Vēstures ieraksti un attēli veiksmīgi saglabāti datubāzē!")

if __name__ == "__main__":
    seed_initial_listings()
