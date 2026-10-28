#!/usr/bin/env python3
"""
importer/run_scrapers.py - Vienots sludinājumu skreiperu palaidējs ar veselības un atskaišu dzinēju
Automātiski reģistrē katra cikla statistiku tabulā `public.scraper_runs`,
fiksē kļūdas, apstrādātos sludinājumus, jaunos objektus un cenu kritumus.
"""

import sys
import time
import argparse
from datetime import datetime
from typing import Dict, Any, List
from scrapers.base import BaseScraper
from scrapers.ss_com import SSComScraper
from scrapers.city24 import City24Scraper
from scrapers.izsoles import IzsolesScraper
from scrapers.pipeline import IngestionPipeline
from scrapers.reaper import SmartReaper

AVAILABLE_SCRAPERS = {
    "ss": SSComScraper,
    "ss.com": SSComScraper,
    "city24": City24Scraper,
    "city24.lv": City24Scraper,
    "izsoles": IzsolesScraper,
    "izsoles.ta.gov.lv": IzsolesScraper,
}

def run_scraper(scraper_name: str, scraper_cls, args, pipeline: IngestionPipeline) -> Dict[str, Any]:
    print(f"\n=======================================================")
    print(f"🚀 Uzsāk skreiperi: {scraper_name.upper()} (Režīms: {args.mode}, Limits: {args.limit or 'Nav'})")
    print(f"=======================================================")

    run_id = pipeline.start_run(scraper_name, args.mode)

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
    new_items = 0
    updated_items = 0
    price_changes = 0
    errors = 0
    last_error = None
    start_time = time.time()

    status = "success"

    try:
        for item in scraper.scrape(limit=args.limit):
            processed += 1
            try:
                ok, is_new, p_changed = pipeline.process_item(item)
                if ok:
                    saved += 1
                    if is_new:
                        new_items += 1
                    else:
                        updated_items += 1
                    if p_changed:
                        price_changes += 1

                if processed % 15 == 0 or processed == 1:
                    pipeline.update_run_progress(run_id, processed, saved, new_items, updated_items, price_changes, errors)
                    print(f"   [{scraper_name}] Apstrādāti: {processed} | Jauni: {new_items} | Atjaunoti: {updated_items} | Cenu izm.: {price_changes} | {item.title[:40] if item.title else item.external_id} ({item.price} €)")
            except Exception as e:
                errors += 1
                last_error = str(e)
                print(f"   ❌ Kļūda saglabājot [{scraper_name}:{item.external_id}]: {e}")

        if errors > 0 and saved == 0:
            status = "failed"
        elif errors > 0:
            status = "warning"

    except KeyboardInterrupt:
        print("\n⚠️ Lietotājs pārtrauca procesu.")
        status = "cancelled"
        last_error = "User cancelled"
    except Exception as e:
        print(f"\n❌ Negaidīta kļūda izpildot {scraper_name}: {e}")
        status = "failed"
        last_error = str(e)

    elapsed = round(time.time() - start_time, 2)

    # Reģistrē noslēgumu datubāzē
    pipeline.finish_run(
        run_id=run_id,
        status=status,
        items_scraped=processed,
        items_saved=saved,
        items_new=new_items,
        items_updated=updated_items,
        price_changes=price_changes,
        errors_count=errors,
        error_message=last_error,
        details={"mode": args.mode, "limit": args.limit},
    )

    print(f"🏁 {scraper_name.upper()} pabeigts {elapsed}s:")
    print(f"   • Statuss:        {status.upper()}")
    print(f"   • Nolasīti:       {processed}")
    print(f"   • Jauni:          {new_items}")
    print(f"   • Atjaunoti:      {updated_items}")
    print(f"   • Cenu izmaiņas:  {price_changes}")
    print(f"   • Kļūdas:         {errors}")

    return {
        "source": scraper_name,
        "status": status,
        "processed": processed,
        "new": new_items,
        "updated": updated_items,
        "price_changes": price_changes,
        "errors": errors,
        "elapsed_sec": elapsed,
        "error_message": last_error,
    }

def print_summary_report(results: List[Dict[str, Any]]):
    print("\n" + "=" * 70)
    print("📊 KOPĒJĀ SLUDINĀJUMU SINHRONIZĀCIJAS ATSKAITE")
    print("=" * 70)
    print(f"{'AVOTS':<15} | {'STATUSS':<10} | {'APSTRĀDĀTI':<10} | {'JAUNI':<7} | {'CENU IZM.':<9} | {'LAIKS':<6}")
    print("-" * 70)
    total_proc = 0
    total_new = 0
    total_price = 0
    total_err = 0

    for r in results:
        total_proc += r["processed"]
        total_new += r["new"]
        total_price += r["price_changes"]
        total_err += r["errors"]
        print(f"{r['source']:<15} | {r['status']:<10} | {r['processed']:<10} | {r['new']:<7} | {r['price_changes']:<9} | {r['elapsed_sec']:<5}s")

    print("-" * 70)
    print(f"{'KOPĀ':<15} | {'—':<10} | {total_proc:<10} | {total_new:<7} | {total_price:<9} | Kļūdas: {total_err}")
    print("=" * 70 + "\n")

def main():
    parser = argparse.ArgumentParser(description="Latvijas nekustamā īpašuma sludinājumu skreiperis un integrācija")
    parser.add_argument("--source", default="all", help="Avots: ss, city24, izsoles vai all (noklusējums: all)")
    parser.add_argument("--limit", type=int, default=None, help="Maksimālais sludinājumu skaits vienam avotam")
    parser.add_argument("--mode", default="today", choices=["today", "full"], help="Režīms: today (ātrais jaunais) vai full (pilnais arhīvs)")
    parser.add_argument("--no-details", action="store_true", help="Neatvērt katra sludinājuma individuālo lapu (ātrāks temps)")
    parser.add_argument("--delay", type=float, default=0.3, help="Aizture starp pieprasījumiem sekundēs (noklusējums 0.3s)")
    parser.add_argument("--daemon", action="store_true", help="Darbināt fonā periodiski kā servisu")
    parser.add_argument("--interval", type=int, default=30, help="Intervāls minūtēs daemon režīmā (noklusējums 30 min)")
    parser.add_argument("--reap", action="store_true", help="Pēc cikla automātiski atslēgt sludinājumus, kas nav redzēti katalogā")
    parser.add_argument("--smart-reap", action="store_true", help="Palaist Smart Reaper ar HTTP un pirkstu nospieduma (fingerprint) pārbaudi")
    parser.add_argument("--reap-only", action="store_true", help="Palaist TIKAI reaperi bez jaunu sludinājumu nolasīšanas")
    parser.add_argument("--reap-days", type=int, default=3, help="Dienu slieksnis neaktīvo atpazīšanai (noklusējums 3 dienas)")
    parser.add_argument("--reap-limit", type=int, default=150, help="Maksimālais sludinājumu skaits vienā Smart Reaper ciklā")

    args = parser.parse_args()

    pipeline = IngestionPipeline()

    # Ja pieprasīts TIKAI reaperis
    if args.reap_only or (args.smart_reap and not args.source):
        try:
            if args.smart_reap:
                reaper = SmartReaper(pipeline.conn, delay=args.delay)
                reaper.run_smart_reap(limit=args.reap_limit, older_than_days=args.reap_days)
            if args.reap or not args.smart_reap:
                pipeline.mark_stale_inactive(days_threshold=args.reap_days)
        finally:
            pipeline.close()
        return

    # Avotu atlase
    if args.source == "all":
        selected_sources = ["city24", "ss", "izsoles"]
    else:
        selected_sources = [s.strip().lower() for s in args.source.split(",") if s.strip().lower() in AVAILABLE_SCRAPERS]

    if not selected_sources:
        print(f"Kļūda: Nav derīgu avotu. Pieejamie: {', '.join(set(AVAILABLE_SCRAPERS.keys()))}")
        pipeline.close()
        sys.exit(1)

    print(f"🗺️ KARTES.KILOGRAMS.LV SLUDINĀJUMU DZINĒJS")
    print(f"Avoti: {', '.join(selected_sources)} | Režīms: {args.mode}")

    try:
        while True:
            cycle_start = time.time()
            results = []
            for src in selected_sources:
                cls = AVAILABLE_SCRAPERS[src]
                res = run_scraper(src, cls, args, pipeline)
                results.append(res)

            print_summary_report(results)

            # Neaktīvo sludinājumu atslēgšana pēc cikla
            if args.reap:
                print(f"🧹 Izpilda kataloga neaktīvo sludinājumu apstrādi (> {args.reap_days} dienas)...")
                pipeline.mark_stale_inactive(days_threshold=args.reap_days)

            if args.smart_reap:
                print(f"🔍 Izpilda Smart Reaper padziļināto pārbaudi (limits: {args.reap_limit})...")
                reaper = SmartReaper(pipeline.conn, delay=args.delay)
                reaper.run_smart_reap(limit=args.reap_limit, older_than_days=args.reap_days)

            if not args.daemon:
                break

            cycle_elapsed = round((time.time() - cycle_start) / 60, 1)
            print(f"💤 Cikls pabeigts {cycle_elapsed} minūtēs. Nākamais starts pēc {args.interval} minūtēm...")
            time.sleep(args.interval * 60)

    finally:
        pipeline.close()

if __name__ == "__main__":
    main()
