"""
importer/scrapers/izsoles.py - Valsts elektronisko izsoļu (izsoles.ta.gov.lv) skreiperis
Skenē tiesu izpildītāju, maksātnespējas un pašvaldību nekustamā īpašuma izsoles.
"""

import re
import time
import requests
from bs4 import BeautifulSoup
from datetime import datetime
from typing import Generator, Optional, List, Dict, Any, Set
from .base import BaseScraper, ListingItem

IZSOLES_URL = "https://izsoles.ta.gov.lv"

class IzsolesScraper(BaseScraper):
    name = "izsoles.ta.gov.lv"

    def __init__(self, request_delay: float = 0.5):
        self.delay = request_delay
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "lv,en-US;q=0.7,en;q=0.3",
        })

    def scrape(self, limit: Optional[int] = None) -> Generator[ListingItem, None, None]:
        """
        Iegūst aktīvās nekustamā īpašuma izsoles
        """
        count = 0
        page = 1
        seen_uuids: Set[str] = set()

        while True:
            post_data = {
                "category": "1",          # Nekustamais īpašums
                "init-search": "1",
            }
            url = f"{IZSOLES_URL}/" if page == 1 else f"{IZSOLES_URL}/{page}"
            try:
                resp = self.session.post(url, data=post_data, timeout=25)
                if resp.status_code != 200:
                    break

                uuids = re.findall(r"href=[\"']https://izsoles\.ta\.gov\.lv/izsole/([a-f0-9\-]{36})[\"']", resp.text)
                if not uuids:
                    break

                page_uuids = [u for u in uuids if u not in seen_uuids]
                if not page_uuids:
                    break

                for uuid in page_uuids:
                    seen_uuids.add(uuid)
                    item = self._fetch_auction_detail(uuid)
                    if item:
                        yield item
                        count += 1
                        if limit and count >= limit:
                            return

                    if self.delay > 0:
                        time.sleep(self.delay)

                page += 1
                if self.delay > 0:
                    time.sleep(self.delay)

            except Exception as e:
                print(f"❌ Kļūda ielādējot izsoles lapu {page}: {e}")
                break

    def _fetch_auction_detail(self, uuid: str) -> Optional[ListingItem]:
        detail_url = f"{IZSOLES_URL}/izsole/{uuid}"
        try:
            resp = self.session.get(detail_url, timeout=20)
            if resp.status_code != 200:
                return None

            html = resp.text
            soup = BeautifulSoup(html, "lxml")

            # Parametri no info-row
            params: Dict[str, str] = {}
            for div in soup.find_all("div", class_="info-row"):
                p_name = div.find("div", class_="info-parameter")
                p_val = div.find("div", class_="info-value")
                if p_name and p_val:
                    key = p_name.get_text(strip=True).rstrip(":")
                    params[key] = p_val.get_text(strip=True)

            price_str = params.get("Sākumcena") or params.get("Aktuālais solījums") or ""
            price = self.safe_float(price_str)

            # Izsoles kārta
            stage_str = params.get("Izsoles kārta") or ""
            stage = self.safe_int(stage_str)

            # Kadastra numurs no saites vai teksta
            cad_match = re.search(r"cadasterId=(\d{11})", html)
            if not cad_match:
                cad_match = re.search(r"Kadastra numurs\s*:\s*<[^>]+>(\d[\d\s]{9,13}\d)", html)
            cad_code = cad_match.group(1).replace(" ", "") if cad_match else None

            # Adrese
            address = params.get("Adrese") or ""

            # Beigu datums
            ends_str = params.get("Izsoles noslēgums") or ""
            pub_date = None
            if ends_str:
                try:
                    # Formāts: 29.10.2026 13:00
                    pub_date = datetime.strptime(ends_str, "%d.%m.%Y %H:%M")
                except Exception:
                    pass

            # Attēli
            images = []
            for a in soup.find_all("a", href=True):
                href = a["href"]
                if href.startswith("http") and href.endswith((".jpg", ".jpeg", ".png", ".webp")):
                    if "/attachments/" in href and href not in images:
                        images.append(href)

            # Apraksts
            title = f"Nekustamā īpašuma izsole: {address or cad_code or uuid[:8]}"

            return ListingItem(
                source="izsoles.ta.gov.lv",
                external_id=uuid,
                deal_type="auction",
                category="other",
                title=title,
                description=f"Izsole {uuid}. Kārta: {stage_str}. {address}",
                url=detail_url,
                price=price,
                currency="EUR",
                address_text=address,
                cadastre_code=cad_code,
                images=images,
                features={
                    "stage": stage,
                    "ends_at": ends_str,
                    "organizer": params.get("Izsoles rīkotājs"),
                },
                published_at=pub_date,
            )

        except Exception as e:
            print(f"⚠️ Neizdevās ielādēt izsoli {uuid}: {e}")
            return None
