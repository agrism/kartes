#!/usr/bin/env bash
# scripts/scrape_listings.sh - Drošs periodiskais sludinājumu atjaunošanas skripts
# Aizsargāts ar failu bloķēšanu (flock) un taimautu (timeout 1200s), lai process nekad nepakārtos.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCK_FILE="/tmp/kartes_scraper.lock"
LOG_FILE="/var/log/kartes_scraper.log"
TIMEOUT_SEC=1200 # Maksimālais izpildes laiks: 20 minūtes

# Pārbauda bloķēšanu ar flock (ja cits skreiperis jau darbojas, šo palaišanu izlaiž)
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ Brīdinājums: Iepriekšējais skreipera process vēl darbojas. Šis cron starts tiek izlaists." | tee -a "$LOG_FILE"
    exit 0
fi

echo "========================================================================" | tee -a "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🚀 SĀK SLUDINĀJUMU SINHRONIZĀCIJU (PID $$)..." | tee -a "$LOG_FILE"
echo "========================================================================" | tee -a "$LOG_FILE"

cd "$PROJECT_DIR"

# Palaiž ar timeout aizsardzību
if timeout "$TIMEOUT_SEC" docker compose run --rm importer run_scrapers.py --source all --mode today 2>&1 | tee -a "$LOG_FILE"; then
    EXIT_CODE=0
    echo "========================================================================" | tee -a "$LOG_FILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Sinhronizācija sekmīgi pabeigta." | tee -a "$LOG_FILE"
    echo "========================================================================" | tee -a "$LOG_FILE"
else
    EXIT_CODE=$?
    echo "========================================================================" | tee -a "$LOG_FILE"
    if [ "$EXIT_CODE" -eq 124 ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ KĻŪDA: Process pārsniedza laika limitu (${TIMEOUT_SEC}s) un tika piespiedu kārtā pārtraukts." | tee -a "$LOG_FILE"
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ KĻŪDA: Skreiperis beidzās ar kļūdas kodu: ${EXIT_CODE}." | tee -a "$LOG_FILE"
    fi
    echo "========================================================================" | tee -a "$LOG_FILE"
fi

exit "$EXIT_CODE"
