#!/usr/bin/env bash
set -e

# Skripts ikmēneša VZD atvērto kadastra datu (visas 42 pašvaldības) automātiskai atjaunināšanai
REPO_DIR="/var/www/kartes.kilograms.lv"
LOG_FILE="/var/log/kartes_cadastre_update.log"

mkdir -p "$(dirname "$LOG_FILE")"

echo "==================================================" >> "$LOG_FILE"
echo "📅 Sāk kadastra datu atjaunināšanu: $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
echo "==================================================" >> "$LOG_FILE"

cd "$REPO_DIR"

# Atbrīvo bufera atmiņu pirms lielās ielādes
sync
echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true

# Palaiž visu 42 novadu ielādi ar pārrakstīšanu (--force)
docker compose run --rm importer --cadastre-all --force >> "$LOG_FILE" 2>&1

# Pārstartē Martin, lai atjaunotu flīžu robežas un metadatus
docker restart kartes-martin >> "$LOG_FILE" 2>&1

echo "==================================================" >> "$LOG_FILE"
echo "✅ Kadastra datu atjaunināšana pabeigta: $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
echo "==================================================" >> "$LOG_FILE"
