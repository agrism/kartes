#!/usr/bin/env python3
"""
importer/generate_tx_pts.py - Vietējā darījumu klasteru punktu ģenerators (Z < 14)
Nolasa visus darījumus no mūsu PostGIS tabulas `public.transactions`,
sakārto telpiski un ģenerē kompaktu, delta-kodētu punktu masīvu `tx-pts.json`.
Aizstāj jebkuru ārēju atkarību ar 100% pašu PostGIS datiem.
"""

import os
import sys
import json
import time
import argparse
from typing import List, Tuple

try:
    import psycopg
except ImportError:
    try:
        import psycopg2 as psycopg
    except ImportError:
        print("Kļūda: Nav atrasta psycopg vai psycopg2 bibliotēka.")
        sys.exit(1)

DEFAULT_DB_URL = "postgresql://kartes:kartes_secret_password@db:5432/kartes"
DEFAULT_OUTPUT_PATH = "web/public/data/tx-pts.json"

def generate_tx_points(db_url: str, output_path: str, limit: int = None) -> Tuple[int, float]:
    print("=======================================================")
    print("🗺️  VIETĒJĀ DARĪJUMU PUNKTIŅU ĢENERATORS (Z < 14)")
    print("=======================================================")
    print(f"Pieslēdzas PostGIS: {db_url.split('@')[-1] if '@' in db_url else db_url}")

    start_time = time.time()
    conn = psycopg.connect(db_url)

    query = """
        SELECT 
            round(ST_X(ST_Transform(geom, 4326))::numeric * 10000)::integer AS x,
            round(ST_Y(ST_Transform(geom, 4326))::numeric * 10000)::integer AS y,
            CASE 
                WHEN property_type ILIKE '%būve%' THEN 1
                WHEN property_type ILIKE '%zeme%' THEN 2
                WHEN property_type = 'zv' THEN 2
                ELSE 0
            END AS ptype
        FROM transactions
        WHERE geom IS NOT NULL
        ORDER BY y ASC, x ASC
    """
    if limit:
        query += f" LIMIT {limit}"

    print("📊 Izpilda telpisko vaicājumu PostGIS...")
    with conn.cursor() as cur:
        cur.execute(query)
        rows = cur.fetchall()

    conn.close()
    query_time = round(time.time() - start_time, 2)
    print(f"✅ Iegūti {len(rows):,} darījumu punkti {query_time} sekundēs.")

    if not rows:
        print("⚠️ Tabulā `transactions` nav atrasti darījumi ar ģeometriju!")
        return 0, 0.0

    print("⚡ Veic koordinātu delta-kodēšanu...")
    encode_start = time.time()
    flat_data: List[int] = []
    prev_x = 0
    prev_y = 0

    for x, y, ptype in rows:
        dx = x - prev_x
        dy = y - prev_y
        flat_data.extend([dx, dy, ptype])
        prev_x = x
        prev_y = y

    # Pārliecināmies, ka mērķa direktorija eksistē
    out_dir = os.path.dirname(output_path)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    print(f"💾 Saglabā failā: {output_path}...")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(flat_data, f, separators=(",", ":"))

    file_size_mb = os.path.getsize(output_path) / (1024 * 1024)
    total_time = round(time.time() - start_time, 2)

    # Verifikācijas tests: atkodējam pirmos 3 punktus, lai apstiprinātu Latvijas robežas
    test_x = 0
    test_y = 0
    print("\n🔍 Integritātes pārbaude (pirmie 3 atkodētie punkti):")
    for i in range(min(3, len(rows))):
        test_x += flat_data[3 * i]
        test_y += flat_data[3 * i + 1]
        lng = test_x / 10000.0
        lat = test_y / 10000.0
        print(f"   • Punkts {i+1}: Lon={lng:.4f}, Lat={lat:.4f} (Tips: {flat_data[3*i+2]})")

    print("\n=======================================================")
    print(f"🎉 Ģenerēšana pabeigta {total_time}s!")
    print(f"   • Darījumu punkti: {len(rows):,}")
    print(f"   • Masīva elementi: {len(flat_data):,}")
    print(f"   • Faila izmērs:    {file_size_mb:.2f} MB")
    print(f"   • Ceļš:            {output_path}")
    print("=======================================================\n")

    return len(rows), file_size_mb

def main():
    parser = argparse.ArgumentParser(description="PostGIS darījumu punktu ģenerators klasteriem (Z < 14)")
    parser.add_argument("--out", default=None, help=f"Izvades faila ceļš (noklusējums: {DEFAULT_OUTPUT_PATH})")
    parser.add_argument("--db-url", default=None, help="PostgreSQL pieslēguma virkne")
    parser.add_argument("--limit", type=int, default=None, help="Ierobežot darījumu skaitu testam")

    args = parser.parse_args()

    db_url = args.db_url or os.environ.get("DATABASE_URL", DEFAULT_DB_URL)
    
    # Ja ceļš nav norādīts, izvēlamies piemērotāko atkarībā no izpildes vides (Docker vai lokāls)
    if args.out:
        out_path = args.out
    elif os.path.exists("/app/web_data"):
        out_path = "/app/web_data/tx-pts.json"
    elif os.path.exists("web/public/data"):
        out_path = "web/public/data/tx-pts.json"
    else:
        out_path = "tx-pts.json"

    generate_tx_points(db_url, out_path, limit=args.limit)

if __name__ == "__main__":
    main()
