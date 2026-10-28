"""
Smart Reaper: Gudrā sludinājumu beigu statusa un kolīziju pārbaude
Pārbauda ne tikai HTTP 200/404, bet arī objekta fiziskās pazīmes (Fingerprint),
lai novērstu gadījumus, kad SS.com piešķir veco ID pavisam citam objektam (piemēram, automašīnai).
"""

import re
import time
import requests
from bs4 import BeautifulSoup
from datetime import datetime
from typing import Dict, Any, Optional, Tuple, List

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "lv,en-US;q=0.9,en;q=0.8,ru;q=0.7",
}

NON_REALESTATE_CATEGORIES = [
    "vieglie auto", "kravas auto", "motocikli", "suņi", "kaķi", "dzīvnieki",
    "būvmateriāli", "mēbeles", "vakances", "darbs", "elektronika", "datori",
    "rezerves daļas", "lauksaimniecība", "ražošana", "apģērbi", "bērnu pasaule"
]

REALESTATE_KEYWORDS = [
    "real-estate", "nekustamie īpašumi", "dzīvokļi", "mājas", "zeme", 
    "biroji", "telpas", "komerctelpas", "garāžas"
]

DELETION_MARKERS = [
    "sludinājums ir izdzēsts",
    "sludinājums vairs nav pieejams",
    "sludinājums ir slēgts",
    "sludinājums netika atrasts",
    "sludinājuma teksts nav atrasts",
    "kļūda! sludinājums nav atrasts"
]


class SmartReaper:
    def __init__(self, db_conn, delay: float = 0.3):
        self.conn = db_conn
        self.delay = delay
        self.session = requests.Session()
        self.session.headers.update(HEADERS)

    def verify_ss_listing(self, row: tuple) -> Tuple[bool, str]:
        """
        Pārbauda SS.com sludinājumu pēc URL un satura pazīmēm.
        row: (id, external_id, url, address_text, area_m2, category, deal_type, rooms)
        Atgriež (is_active: bool, reason: str)
        """
        lid, ext_id, url, addr_text, area_m2, category, deal_type, rooms = row

        if not url or "ss.com" not in url:
            return False, "invalid_url"

        try:
            resp = self.session.get(url, timeout=10, allow_redirects=True)
            
            # 1. HTTP statusa kodi
            if resp.status_code in (404, 410):
                return False, "http_404"
            if resp.status_code != 200:
                return False, f"http_{resp.status_code}"

            html = resp.text.lower()

            # 2. Pārbauda, vai lapa satur tekstuālus dzēšanas paziņojumus
            for marker in DELETION_MARKERS:
                if marker in html:
                    return False, f"marker_{marker.replace(' ', '_')}"

            # 3. Pārbauda virsrakstu un sadaļu (Breadcrumbs / headtitle)
            soup = BeautifulSoup(resp.text, "lxml")
            head_el = soup.find("h2", class_="headtitle")
            title_el = soup.find("title")

            head_text = (head_el.get_text(separator=" ").lower() if head_el else "")
            page_title = (title_el.get_text().lower() if title_el else "")
            full_context = f"{head_text} {page_title}"

            # Pārbauda kolīziju: vai lapa nepieder citai kategorijai (piem., automašīnām vai suņiem)
            for non_re in NON_REALESTATE_CATEGORIES:
                if non_re in full_context:
                    return False, f"category_collision_{non_re.replace(' ', '_')}"

            # Pārbauda, vai vispār satur nekustamā īpašuma pazīmes
            has_re_context = any(kw in full_context or kw in resp.url.lower() for kw in REALESTATE_KEYWORDS)
            if not has_re_context:
                return False, "not_real_estate_context"

            # 4. Pārbauda adresi, ja tāda bija saglabāta
            if addr_text:
                # Izvelkam adresi no SS.com tabulas (<td class="ads_opt" id="tdo_11">)
                opt_addr = soup.find("td", id="tdo_11")
                page_addr_text = opt_addr.get_text(strip=True) if opt_addr else ""

                if page_addr_text:
                    clean_expected = re.sub(r"[^\w\s]", "", addr_text.lower()).strip()
                    clean_page = re.sub(r"[^\w\s]", "", page_addr_text.lower()).strip()
                    exp_words = set(w for w in clean_expected.split() if len(w) > 2)
                    page_words = set(w for w in clean_page.split() if len(w) > 2)

                    # Ja abiem ir vārdi, bet tie ir 100% atšķirīgi (piemēram Brīvības vs Dzelzavas)
                    if exp_words and page_words and not (exp_words & page_words):
                        return False, f"address_mismatch_{clean_page[:20]}"

            # 5. Pārbauda platību m², ja tāda bija saglabāta
            if area_m2 and float(area_m2) > 10:
                opt_area = soup.find("td", id="tdo_const_3") or soup.find("td", id="tdo_3")
                if opt_area:
                    m = re.search(r"(\d+(?:[\.,]\d+)?)", opt_area.get_text(strip=True))
                    if m:
                        try:
                            found_area = float(m.group(1).replace(",", "."))
                            expected_area = float(area_m2)
                            if abs(found_area - expected_area) > 4.0 and (abs(found_area - expected_area) / expected_area) > 0.20:
                                return False, f"area_mismatch_{found_area}_vs_{expected_area}"
                        except ValueError:
                            pass

            return True, "verified_active"

        except requests.exceptions.RequestException as e:
            return True, f"network_error_skip_{str(e)[:30]}"

    def verify_city24_listing(self, row: tuple) -> Tuple[bool, str]:
        """
        Pārbauda City24 sludinājumu caur oficiālo API
        """
        lid, ext_id, url, addr_text, area_m2, category, deal_type, rooms = row
        api_url = f"https://api.city24.lv/lv_LV/search/realties/{ext_id}"

        try:
            resp = self.session.get(api_url, timeout=8)
            if resp.status_code == 404:
                return False, "city24_404"
            if resp.status_code == 200:
                data = resp.json()
                # Pārbauda objekta statusu
                status = data.get("status", "").upper()
                if status in ("ARCHIVED", "INACTIVE", "DELETED"):
                    return False, f"city24_status_{status}"
                return True, "verified_active"
            return True, f"city24_http_{resp.status_code}"
        except Exception as e:
            return True, f"city24_error_skip_{str(e)[:30]}"

    def run_smart_reap(self, limit: int = 150, older_than_days: int = 5, source: Optional[str] = None) -> Dict[str, Any]:
        """
        Atlasa senākos aktīvos sludinājumus un pārbauda to statusu pēc pirkstu nospieduma
        """
        with self.conn.cursor() as cur:
            query = """
                SELECT id, external_id, url, address_text, area_m2, category, deal_type, rooms, source
                FROM listings
                WHERE is_active = true
                  AND last_seen_at < CURRENT_TIMESTAMP - (%s || ' days')::interval
            """
            params = [older_than_days]
            if source:
                query += " AND source = %s"
                params.append(source)
            query += " ORDER BY last_seen_at ASC LIMIT %s;"
            params.append(limit)

            cur.execute(query, params)
            rows = cur.fetchall()

        if not rows:
            print(f"✅ Nav neviena aktīva sludinājuma, kas nebūtu pārbaudīts pēdējās {older_than_days} dienās.")
            return {"total": 0, "active": 0, "closed": 0, "reasons": {}}

        print(f"\n🔍 Smart Reaper: pārbauda {len(rows)} aktīvos sludinājumus (senāki par {older_than_days} dienām)...")

        active_count = 0
        closed_count = 0
        reasons: Dict[str, int] = {}

        for row in rows:
            lid, ext_id, url, addr_text, area_m2, category, deal_type, rooms, src = row
            sub_row = (lid, ext_id, url, addr_text, area_m2, category, deal_type, rooms)

            if src == "ss.com":
                is_active, reason = self.verify_ss_listing(sub_row)
            elif src == "city24.lv":
                is_active, reason = self.verify_city24_listing(sub_row)
            else:
                is_active, reason = True, "unsupported_source"

            reasons[reason] = reasons.get(reason, 0) + 1

            with self.conn.cursor() as cur:
                if not is_active:
                    # Atzīmē kā slēgtu
                    cur.execute("""
                        UPDATE listings SET
                            is_active = false,
                            closed_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s;
                    """, (lid,))
                    closed_count += 1
                    print(f"   ❌ Slēgts [{src}:{ext_id}]: {reason} ({addr_text or ''})")
                else:
                    # Atjauno last_seen_at, lai nākamo reizi netiktu lieki pārbaudīts
                    cur.execute("""
                        UPDATE listings SET
                            last_seen_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s;
                    """, (lid,))
                    active_count += 1

            if self.delay > 0:
                time.sleep(self.delay)

        self.conn.commit()

        print(f"\n📊 Smart Reaper kopsavilkums:")
        print(f"   Pārbaudīti:     {len(rows)}")
        print(f"   Joprojām aktīvi: {active_count}")
        print(f"   Slēgti/Dzēsti:   {closed_count}")
        print(f"   Iemesli:         {reasons}\n")

        return {
            "total": len(rows),
            "active": active_count,
            "closed": closed_count,
            "reasons": reasons
        }
