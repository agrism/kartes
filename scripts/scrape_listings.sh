#!/usr/bin/env bash
set -e

# scripts/scrape_listings.sh - Periodiskais sludinājumu atjaunošanas skripts
# Iegūst jaunos sludinājumus un cenu izmaiņas no ss.com, city24.lv un izsoles.ta.gov.lv

cd "$(dirname "$0")/.."

echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Sāk sludinājumu sinhronizāciju..."
docker compose run --rm importer run_scrapers.py --source all --mode today
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Sludinājumu sinhronizācija pabeigta."
