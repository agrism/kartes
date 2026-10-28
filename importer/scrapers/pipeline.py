"""
importer/scrapers/pipeline.py - Sludinājumu apstrādes konveijers
Veic adrešu ģeokodēšanu, kadastra piesaisti ar PostGIS, cenu dinamikas fiksēšanu un sinhronizāciju.
"""

import os
import re
import json
import psycopg
from datetime import datetime, date
from typing import Optional, Tuple, Dict, Any
from .base import ListingItem

DEFAULT_DB_URL = "postgresql://kartes:kartes_secret_password@db:5432/kartes"

class IngestionPipeline:
    def __init__(self, db_url: Optional[str] = None):
        self.db_url = db_url or os.environ.get("DATABASE_URL", DEFAULT_DB_URL)
        self.conn = psycopg.connect(self.db_url)
        self.conn.autocommit = True
        self._cache_address_searches: Dict[str, Optional[Tuple[float, float]]] = {}

    def close(self):
        if self.conn and not self.conn.closed:
            self.conn.close()

    def process_item(self, item: ListingItem) -> bool:
        """
        Apstrādā vienu sludinājumu un sinhronizē ar PostGIS datubāzi.
        """
        with self.conn.cursor() as cur:
            # 1. Ģeokodēšana (ja koordinātas nav dotas)
            if not item.lng or not item.lat:
                coords = self._geocode(cur, item)
                if coords:
                    item.lng, item.lat = coords

            # 2. Kadastra zemes vienības noteikšana no koordinātām
            if not item.cadastre_code and item.lng and item.lat:
                cad_code = self._find_cadastre_by_coords(cur, item.lng, item.lat)
                if cad_code:
                    item.cadastre_code = cad_code

            # 3. Pārbauda, vai sludinājums jau eksistē
            cur.execute("""
                SELECT id, price, first_price, days_on_market, first_seen_at, address_text, area_m2, category, deal_type, rooms
                FROM listings
                WHERE source = %s AND external_id = %s
            """, (item.source, item.external_id))
            row = cur.fetchone()

            if row:
                listing_id, old_price, first_price, days_on_market, first_seen_at, old_addr, old_area, old_cat, old_deal, old_rooms = row

                # Pārbauda "pirkstu nospiedumu" (pazīmes): vai tas tiešām ir TAS PATS īpašums, vai arī portāls
                # šo ID ir pārstrādājis citam objektam (kolīzija)?
                if not self._is_same_listing(row, item):
                    # Kolīzija! SS.com ir piešķīris šo ID citam objektam.
                    # Arhivējam veco sludinājumu, atbrīvojot unikālo external_id atslēgu.
                    archived_ext_id = f"{item.external_id}_archived_{listing_id}"
                    cur.execute("""
                        UPDATE listings SET
                            external_id = %s,
                            is_active = false,
                            closed_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s
                    """, (archived_ext_id, listing_id))
                    print(f"   ⚠️ ID kolīzija [{item.source}:{item.external_id}]! Vecais {old_addr} ({old_area}m²) arhivēts, tiek veidots jauns ieraksts.")
                    row = None  # Izraisīs jaunā sludinājuma INSERT zemāk

            if row:
                # Eksistējošs sludinājums ar sakrītošām pazīmēm - pārbauda cenu izmaiņas
                listing_id, old_price, first_price, days_on_market, first_seen_at = row[:5]
                price_changed = False
                
                if item.price is not None and old_price is not None and abs(float(item.price) - float(old_price)) > 0.01:
                    price_changed = True
                    delta_amt = float(item.price) - float(old_price)
                    delta_pct = round((delta_amt / float(old_price)) * 100, 2) if float(old_price) > 0 else 0
                    
                    cur.execute("""
                        INSERT INTO listing_price_changes (
                            listing_id, change_date, old_price, new_price, delta_amount, delta_percent
                        ) VALUES (%s, CURRENT_DATE, %s, %s, %s, %s)
                    """, (listing_id, old_price, item.price, delta_amt, delta_pct))
                    print(f"   📉 Cenas izmaiņa [{item.source}:{item.external_id}]: {old_price} -> {item.price} € ({delta_pct}%)")

                # Aprēķina dienas tirgū
                now = datetime.now()
                days = max(1, (now.date() - first_seen_at.date()).days) if first_seen_at else (days_on_market or 1)

                # Atjauno sludinājumu
                cur.execute("""
                    UPDATE listings SET
                        price = COALESCE(%s, price),
                        price_per_m2 = COALESCE(%s, price_per_m2),
                        url = %s,
                        images = %s,
                        features = %s,
                        cadastre_code = COALESCE(%s, cadastre_code),
                        geom = COALESCE(ST_SetSRID(ST_MakePoint(%s::float, %s::float), 4326), geom),
                        geom_3857 = COALESCE(ST_Transform(ST_SetSRID(ST_MakePoint(%s::float, %s::float), 4326), 3857), geom_3857),
                        last_seen_at = CURRENT_TIMESTAMP,
                        days_on_market = %s,
                        is_active = true,
                        closed_at = NULL,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s
                """, (
                    item.price,
                    item.price_per_m2,
                    item.url,
                    json.dumps(item.images),
                    json.dumps(item.features),
                    item.cadastre_code,
                    item.lng, item.lat,
                    item.lng, item.lat,
                    days,
                    listing_id
                ))
                return True, False, price_changed  # success, is_new, price_changed
            else:
                # Jauns sludinājums
                cur.execute("""
                    INSERT INTO listings (
                        source, external_id, deal_type, category, title, description, url,
                        price, first_price, currency, price_per_m2, area_m2, rooms, floor,
                        total_floors, series, house_type, address_text, town, district,
                        cadastre_code, images, features, geom, geom_3857, published_at,
                        first_seen_at, last_seen_at, days_on_market, is_active
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s,
                        %s, %s, %s,
                        ST_SetSRID(ST_MakePoint(%s::float, %s::float), 4326),
                        ST_Transform(ST_SetSRID(ST_MakePoint(%s::float, %s::float), 4326), 3857),
                        %s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, true
                    )
                """, (
                    item.source,
                    item.external_id,
                    item.deal_type,
                    item.category,
                    item.title or f"{item.deal_type.capitalize()} {item.address_text or ''}",
                    item.description or "",
                    item.url,
                    item.price,
                    item.price, # first_price
                    item.currency,
                    item.price_per_m2,
                    item.area_m2,
                    item.rooms,
                    item.floor,
                    item.total_floors,
                    item.series,
                    item.house_type,
                    item.address_text,
                    item.town,
                    item.district,
                    item.cadastre_code,
                    json.dumps(item.images),
                    json.dumps(item.features),
                    item.lng, item.lat,
                    item.lng, item.lat,
                    item.published_at or datetime.now(),
                ))
                return True, True, False  # success, is_new, price_changed

    def start_run(self, source: str, mode: str = "today") -> int:
        """
        Reģistrē skreipera cikla sākumu un atgriež run_id
        """
        with self.conn.cursor() as cur:
            cur.execute("""
                INSERT INTO scraper_runs (source, mode, status, started_at)
                VALUES (%s, %s, 'running', CURRENT_TIMESTAMP)
                RETURNING id;
            """, (source, mode))
            row = cur.fetchone()
            return row[0]

    def update_run_progress(
        self,
        run_id: int,
        items_scraped: int,
        items_saved: int,
        items_new: int,
        items_updated: int,
        price_changes: int,
        errors_count: int,
    ):
        """
        Periodiski atjauno tekošo progresu datubāzē, kamēr process darbojas
        """
        with self.conn.cursor() as cur:
            cur.execute("""
                UPDATE scraper_runs SET
                    items_scraped = %s,
                    items_saved = %s,
                    items_new = %s,
                    items_updated = %s,
                    price_changes = %s,
                    errors_count = %s
                WHERE id = %s;
            """, (items_scraped, items_saved, items_new, items_updated, price_changes, errors_count, run_id))

    def finish_run(
        self,
        run_id: int,
        status: str = "success",
        items_scraped: int = 0,
        items_saved: int = 0,
        items_new: int = 0,
        items_updated: int = 0,
        price_changes: int = 0,
        errors_count: int = 0,
        error_message: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ):
        """
        Reģistrē skreipera cikla noslēgumu un saglabā statistiku
        """
        with self.conn.cursor() as cur:
            cur.execute("""
                UPDATE scraper_runs SET
                    status = %s,
                    finished_at = CURRENT_TIMESTAMP,
                    duration_sec = ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at))::numeric, 2),
                    items_scraped = %s,
                    items_saved = %s,
                    items_new = %s,
                    items_updated = %s,
                    price_changes = %s,
                    errors_count = %s,
                    error_message = %s,
                    details = %s
                WHERE id = %s;
            """, (
                status,
                items_scraped,
                items_saved,
                items_new,
                items_updated,
                price_changes,
                errors_count,
                error_message,
                json.dumps(details or {}),
                run_id,
            ))

    def _geocode(self, cur, item: ListingItem) -> Optional[Tuple[float, float]]:
        """
        Meklē koordinātas Valsts adrešu reģistrā vai kadastrā
        """
        # Ja ir kadastra kods, paņemam no parcels
        if item.cadastre_code:
            cur.execute("""
                SELECT ST_X(ST_Centroid(ST_Transform(geom, 4326))), ST_Y(ST_Centroid(ST_Transform(geom, 4326)))
                FROM parcels
                WHERE code = %s
                LIMIT 1
            """, (item.cadastre_code,))
            res = cur.fetchone()
            if res and res[0] and res[1]:
                return float(res[0]), float(res[1])

        # Ģeokodēšana pēc adreses teksta
        if not item.address_text:
            return None

        cache_key = f"{item.town or ''}|{item.address_text}"
        if cache_key in self._cache_address_searches:
            return self._cache_address_searches[cache_key]

        raw_addr = item.address_text.strip()
        # Noņemam pilsētas prefiksu (piemēram "Rīga, Elizabetes 13" vai "Jelgava un raj., Zirgu 1")
        clean_addr = re.sub(r"^(?:Rīga|Jūrmala|Jelgava|Liepāja|Daugavpils|Valmiera|Ventspils|Ogre|Cēsis)[^,]*,?\s*", "", raw_addr, flags=re.IGNORECASE).strip()

        # Izvelkam ielas nosaukumu un numuru
        # Piemēram: "Elizabetes 13" -> "Elizabetes" un "13"
        # "Pavasara g. 6" -> "Pavasara" un "6"
        m = re.search(r"([A-Za-zĀ-ž\.\s\-]+?)\s+(\d+[a-zA-Z]?)", clean_addr)
        if m:
            street_word = m.group(1).replace(".", "").strip().split()[-1] # pēdējais vārds, piem. "Elizabetes"
            num_word = m.group(2).strip()

            query = f"%{street_word}%{num_word}%"
            town_filter = f"%{item.town}%" if item.town else "%"

            cur.execute("""
                SELECT ST_X(ST_Transform(geom, 4326)), ST_Y(ST_Transform(geom, 4326))
                FROM addresses
                WHERE address ILIKE %s AND address ILIKE %s
                LIMIT 1
            """, (query, town_filter))
            res = cur.fetchone()
            if res and res[0] and res[1]:
                coords = (float(res[0]), float(res[1]))
                self._cache_address_searches[cache_key] = coords
                return coords

        self._cache_address_searches[cache_key] = None
        return None

    def _find_cadastre_by_coords(self, cur, lng: float, lat: float) -> Optional[str]:
        """
        Atrod kadastra zemes vienības kodu no PostGIS parcels ģeometrijas
        """
        try:
            cur.execute("""
                SELECT code
                FROM parcels
                WHERE ST_Contains(geom, ST_Transform(ST_SetSRID(ST_MakePoint(%s, %s), 4326), 3857))
                LIMIT 1
            """, (lng, lat))
            res = cur.fetchone()
            if res and res[0]:
                return str(res[0])
        except Exception:
            pass
        return None

    def _is_same_listing(self, existing_row, item: ListingItem) -> bool:
        """
        Pārbauda, vai ienākošais sludinājums atbilst esošajam ierakstam pēc fiziskajām pazīmēm.
        Ja SS.com ir piešķīris veco ID citam sludinājumam (kolīzija), atgriež False.
        """
        listing_id, old_price, first_price, days_on_market, first_seen_at, old_addr, old_area, old_cat, old_deal, old_rooms = existing_row

        # 1. Kategorija un darījuma tips
        if old_cat and item.category and old_cat != item.category:
            return False
        if old_deal and item.deal_type and old_deal != item.deal_type:
            return False

        # 2. Platības pārbaude (ja abiem norādīta un ir virs 10 m2)
        if old_area is not None and item.area_m2 is not None:
            try:
                oa = float(old_area)
                na = float(item.area_m2)
                # Ja platības atšķirība ir lielāka par 3 m2 un pārsniedz 15%
                if oa > 10 and na > 10 and abs(oa - na) > 3.0 and (abs(oa - na) / oa) > 0.15:
                    return False
            except (ValueError, TypeError):
                pass

        # 3. Istabu skaits (ja abiem norādīts)
        if old_rooms is not None and item.rooms is not None:
            if old_rooms > 0 and item.rooms > 0 and abs(old_rooms - item.rooms) >= 2:
                return False

        # 4. Adreses pārbaude (ja abiem ir adrese)
        if old_addr and item.address_text:
            oa_clean = re.sub(r"[^\w\s]", "", old_addr.lower()).strip()
            na_clean = re.sub(r"[^\w\s]", "", item.address_text.lower()).strip()
            oa_words = set(w for w in oa_clean.split() if len(w) > 2)
            na_words = set(w for w in na_clean.split() if len(w) > 2)
            # Ja abiem ir vārdi, bet nav neviena kopīga vārda (piem., "brīvības" vs "dzelzavas")
            if oa_words and na_words and not (oa_words & na_words):
                return False

        return True

    def mark_stale_inactive(self, days_threshold: int = 3, source: Optional[str] = None) -> int:
        """
        Atzīmē kā neaktīvus sludinājumus, kas nav manīti aktīvajā katalogā vairāk par days_threshold dienām.
        """
        with self.conn.cursor() as cur:
            query = """
                UPDATE listings
                SET is_active = false,
                    closed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE is_active = true
                  AND last_seen_at < CURRENT_TIMESTAMP - (%s || ' days')::interval
            """
            params = [days_threshold]
            if source:
                query += " AND source = %s"
                params.append(source)
            query += " RETURNING id;"
            cur.execute(query, params)
            closed_rows = cur.fetchall()
            count = len(closed_rows)
            if count > 0:
                print(f"🧹 Kataloga reaperis: atzīmēti kā neaktīvi {count} sludinājumi (nav manīti {days_threshold}+ dienas)")
            return count
