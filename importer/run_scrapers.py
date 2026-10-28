#!/usr/bin/env python3
"""
importer/run_scrapers.py - Vienots sludinājumu skreiperu palaidējs
Palaidējs atbalsta ss.com, city24.lv un izsoles.ta.gov.lv skreiperus,
automātiski apstrādā datus caur IngestionPipeline un sinhronizē ar PostGIS.

Piemēri:
  python run_scrapers.py --source city24 --limit 100
  python run_scrapers.py --source ss --limit 50 --mode today
  python run_scrapers.py --source izsoles --limit 30
  python run_scrapers.py --source all --mode today
  python run_scrapers.py --source all --daemon --interval 30
"""

import sys
import time
import argparse
from datetime import datetime
from scrapers.base import BaseScraper
from scrapers.ss_com import SSComScraper
from scrapers.city24 import City24Scraper
from scrapers.izsoles import IzsolesScraper
from scrapers.pipeline import IngestionPipeline

AVAILABLE_SCRAPERS = {
    "ss": SSComScraper,
    "ss.com": SSComScraper,
    "city24": City24Scraper,
    "city24.lv": City24Scraper,
    "izsoles": IzsolesScraper,
    "izsoles.ta.gov.lv": IzsolesScraper,
}

def run_scraper(scraper_name: str, scraper_cls, args, pipeline: IngestionPipeline):
    print(f"\n=======================================================")
    print(f"🚀 Uzsāk skreiperi: {scraper_name.upper()} (Režīms: {args.mode}, Limits: {args.limit or 'Nav'})")
    print(f"=======================================================")

    kwargs = {}
    if scraper_cls == SSComScraper:
        kwargs["mode"] = args.mode
        kwargs["fetch_details"] = not args.no_details
        kwargs["request_delay"] = args.delay
    elif scraper_cls in (City24Scraper, IzsolesScraper):
        kwargs["request_delay"] = args.delay

    scraper: BaseScraper = scraper_cls(**kwargs)
    processed = 0
    saved = 0
    errors = 0
    start_time = time.time()

    try:
        for item in scraper.scrape(limit=args.limit):
            processed += 1
            try:
                ok = pipeline.process_item(item)
                if ok:
                    saved += 1
                if processed % 10 == 0 or processed == 1:
                    print(f"   [{scraper_name}] Apstrādāti {processed} | Saglabāti {saved} | {item.title[:45] if item.title else item.external_id} ({item.price} €)")
            except Exception as e:
                errors += 1
                print(f"   ❌ Kļūda saglabājot {item.external_id}: {e}")

    except KeyboardInterrupt:
        print("\n⚠️ Lietotājs pārtrauca procesu.")
    except Exception as e:
        print(f"\n❌ Negaidīta kļūda izpildot {scraper_name}: {e}")

    elapsed = round(time.time() - start_time, 1)
    print(f"✅ {scraper_name.upper()} pabeigts {elapsed}s: Apstrādāti {processed}, Veiksmīgi saglabāti {saved}, Kļūdas {errors}.\n")

def main():
    parser = argparse.ArgumentParser(description="Latvijas nekustamā īpašuma sludinājumu skreiperis un integrācija")
    parser.add_argument("--source", default="all", help="Avots: ss, city24, izsoles vai all (noklusējums: all)")
    parser.add_argument("--limit", type=int, default=None, help="Maksimālais sludinājumu skaits vienam avotam")
    parser.add_argument("--mode", default="today", choices=["today", "full"], help="Režīms: today (ātrais jaunais) vai full (pilnais arhīvs)")
    parser.add_argument("--no-details", action="store_true", help="Neatvērt katra sludinājuma individuālo lapu (ātrāks temps)")
    parser.add_argument("--delay", type=float, default=0.3, help="Aizture starp pieprasījumiem sekundēs (noklusējums 0.3s)")
    parser.add_argument("--daemon", action="store_true", help="Darbināt fonā periodiski kā servisu")
    parser.add_argument("--interval", type=int, default=30, help="Intervāls minūtēs daemon režīmā (noklusējums 30 min)")

    args = parser.parse_args()

    # Avotu atlase
    if args.source == "all":
        selected_sources = ["city24", "ss", "izsoles"]
    else:
        selected_sources = [s.strip().lower() for s in args.source.split(",") if s.strip().lower() in AVAILABLE_SCRAPERS]

    if not selected_sources:
        print(f"Kļūda: Nav derīgu avotu. Pieejamie: {', '.join(set(AVAILABLE_SCRAPERS.keys()))}")
        sys.exit(1)

    print(f"🗺️ KARTES.KILOGRAMS.LV SLUDINĀJUMU DZINĒJS")
    print(f"Avoti: {', '.join(selected_sources)} | Režīms: {args.mode}")

    pipeline = IngestionPipeline()

    try:
        while True:
            cycle_start = time.time()
            for src in selected_sources:
                cls = AVAILABLE_SCRAPERS[src]
                run_scraper(src, cls, args, pipeline)

            if not args.daemon:
                break

            cycle_elapsed = round((time.time() - cycle_start) / 60, 1)
            print(f"💤 Cikls pabeigts {cycle_elapsed} minūtēs. Nākamais starts pēc {args.interval} minūtēm...")
            time.sleep(args.interval * 60)

    finally:
        pipeline.close()

if __name__ == "__main__":
    main()
