"""
importer/scrapers/ss_com.py - SS.COM nekustamā īpašuma skreiperis
Skenē ss.com sludinājumu sarakstus (šodienas vai kategoriju) un iegūst parametrus, fotogrāfijas un adreses.
"""

import re
import time
import requests
from bs4 import BeautifulSoup
from typing import Generator, Optional, List, Dict, Any, Set
from .base import BaseScraper, ListingItem

BASE_URL = "https://www.ss.com"

# Galvenās nekustamā īpašuma sadaļas
SECTIONS = {
    "flats": "/lv/real-estate/flats/",
    "houses": "/lv/real-estate/homes-summer-residences/",
    "plots": "/lv/real-estate/plots-and-land/",
    "commercial": "/lv/real-estate/premises/",
    "wood": "/lv/real-estate/wood/",
}

# Šodienas sludinājumu sadaļas ātrai sinhronizācijai
TODAY_SECTIONS = {
    "flats": "/lv/real-estate/flats/today/",
    "houses": "/lv/real-estate/homes-summer-residences/today/",
    "plots": "/lv/real-estate/plots-and-land/today/",
    "commercial": "/lv/real-estate/premises/today/",
}

class SSComScraper(BaseScraper):
    name = "ss.com"

    def __init__(self, mode: str = "today", fetch_details: bool = True, request_delay: float = 0.5):
        """
        mode: 'today' (tikai šodienas jaunie sludinājumi) vai 'full' (visas sadaļas)
        fetch_details: vai atvērt katru sludinājumu pilno bilžu un apraksta iegūšanai
        """
        self.mode = mode
        self.fetch_details = fetch_details
        self.delay = request_delay
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "lv,en-US;q=0.7,en;q=0.3",
        })

    def scrape(self, limit: Optional[int] = None) -> Generator[ListingItem, None, None]:
        sections = TODAY_SECTIONS if self.mode == "today" else SECTIONS
        count = 0
        seen_ids: Set[str] = set()

        for category, path in sections.items():
            print(f"🔍 SS.COM skenē sadaļu: {category} ({path})...")
            page = 1
            while True:
                page_url = f"{BASE_URL}{path}" if page == 1 else f"{BASE_URL}{path}page{page}.html"
                try:
                    resp = self.session.get(page_url, timeout=20)
                    if resp.status_code != 200:
                        break

                    soup = BeautifulSoup(resp.text, "lxml")
                    rows = soup.find_all("tr", id=re.compile(r"^tr_\d+"))
                    if not rows:
                        break

                    found_in_page = 0
                    for tr in rows:
                        item = self._parse_table_row(tr, category)
                        if not item or item.external_id in seen_ids:
                            continue

                        seen_ids.add(item.external_id)
                        found_in_page += 1

                        # Papildu detaļu ielāde (ja ieslēgts)
                        if self.fetch_details and item.url:
                            self._enrich_item_details(item)
                            if self.delay > 0:
                                time.sleep(self.delay)

                        yield item
                        count += 1
                        if limit and count >= limit:
                            return

                    if found_in_page == 0:
                        break

                    # Pārbauda nākamo lapu
                    next_link = soup.find("a", rel="next") or soup.find("a", text=re.compile(r"Nākamie|>>"))
                    if not next_link:
                        break

                    page += 1
                    if self.delay > 0:
                        time.sleep(self.delay)

                except Exception as e:
                    print(f"❌ Kļūda ielādējot {page_url}: {e}")
                    break

    def _parse_table_row(self, tr, category: str) -> Optional[ListingItem]:
        # Ekstrahē ID
        tr_id = tr.get("id", "")
        m = re.search(r"tr_(\d+)", tr_id)
        if not m:
            return None
        ext_id = m.group(1)

        # Saiti un attēlu
        link_el = tr.find("a", class_="am") or tr.find("a", id=re.compile(r"^dm_"))
        if not link_el:
            return None
        href = link_el.get("href", "")
        if not href.startswith("http"):
            href = f"{BASE_URL}{href}"

        title = link_el.get_text(strip=True)

        img_el = tr.find("img", class_="isfoto")
        thumb_url = img_el.get("src") if img_el else ""
        if thumb_url and thumb_url.endswith("homes.lv.gif"):
            # Speciālā pirkšanas ikona - parasti pirkšanas sludinājumi
            thumb_url = ""

        # Šūnas
        tds = tr.find_all("td", class_=re.compile(r"msga2-o"))
        if not tds:
            return None

        # Pēdējā šūna parasti ir cena
        price_text = tds[-1].get_text(strip=True).replace("\xa0", " ")
        if any(w in price_text.lower() for w in ["pērku", "maina", "nopirkšu", "vēlos"]):
            return None  # Izlaižam pirkšanas pieprasījumus

        deal_type = "rent" if any(w in price_text.lower() for w in ["mēn", "dien", "/m", "izīrē"]) else "sell"
        price = self.safe_float(price_text)
        if not price or price <= 0:
            return None

        # Adreses lauks (parasti pirmais no msga2-o)
        addr_td = tds[0]
        # Pārvērš <br> par komatu
        for br in addr_td.find_all("br"):
            br.replace_with(", ")
        addr_text = addr_td.get_text(strip=True)

        # Noteiksim pilsētu un rajonu
        town = ""
        district = ""
        if "riga" in href.lower():
            town = "Rīga"
            # Ekstrahē rajonu no saites: /flats/riga/purvciems/...
            parts = href.split("/")
            if len(parts) >= 8:
                district = parts[7].capitalize()
        elif "jurmala" in href.lower():
            town = "Jūrmala"
        elif "riga-region" in href.lower():
            town = "Rīgas rajons"

        # Pārējās kolonnas atkarībā no kategorijas
        rooms = None
        area_m2 = None
        floor = None
        total_floors = None
        series = None

        if category == "flats" and len(tds) >= 5:
            # Tipiska struktūra: Vieta, Istabas, Platība, Stāvs, Sērija, Cena
            # [0] = Vieta
            # [1] = Istabas
            # [2] = Platība
            # [3] = Stāvs (vai sērija)
            # [4] = Sērija (vai cena)
            rooms = self.safe_int(tds[1].get_text(strip=True))
            area_m2 = self.safe_float(tds[2].get_text(strip=True))
            if len(tds) >= 6:
                floor, total_floors = self.parse_floor(tds[3].get_text(strip=True))
                series = tds[4].get_text(strip=True)
            elif len(tds) == 5:
                floor, total_floors = self.parse_floor(tds[3].get_text(strip=True))
        elif category in ("houses", "plots") and len(tds) >= 3:
            # Mājas: Vieta, m2, stāvi, zeme, cena
            area_m2 = self.safe_float(tds[1].get_text(strip=True))

        images = [thumb_url] if thumb_url else []

        ppm2 = round(price / area_m2, 2) if (area_m2 and area_m2 > 0 and price and deal_type == "sell") else None

        return ListingItem(
            source="ss.com",
            external_id=ext_id,
            deal_type=deal_type,
            category=category,
            title=title,
            description=title,
            url=href,
            price=price,
            price_per_m2=ppm2,
            area_m2=area_m2,
            rooms=rooms,
            floor=floor,
            total_floors=total_floors,
            series=series,
            address_text=addr_text,
            town=town,
            district=district,
            images=images,
        )

    def _enrich_item_details(self, item: ListingItem):
        """
        Iegūst pilnos attēlus un aprakstu no sludinājuma individuālās lapas
        """
        try:
            resp = self.session.get(item.url, timeout=12)
            if resp.status_code != 200:
                return

            html = resp.text
            # Pilnie galerijas attēli (800x600)
            full_imgs = re.findall(r"(https://i\.ss\.com/gallery/[^\"\'\s>]+\.800\.jpg)", html)
            if full_imgs:
                # Saglabājam unikālos attēlus
                seen = set()
                uniq_imgs = []
                for img in full_imgs:
                    if img not in seen:
                        seen.add(img)
                        uniq_imgs.append(img)
                if uniq_imgs:
                    item.images = uniq_imgs

            # Apraksta teksts
            soup = BeautifulSoup(html, "lxml")
            msg_div = soup.find("div", id="msg_div_msg")
            if msg_div:
                desc = msg_div.get_text(separator="\n", strip=True)
                if desc:
                    item.description = desc

            # Kadastra numurs aprakstā vai tabulā (piem. 0100...)
            cad_match = re.search(r"(\b\d{11}\b)", html)
            if cad_match:
                item.cadastre_code = cad_match.group(1)

        except Exception as e:
            # Neļaujam detaļu kļūdai apturēt plūsmu
            pass
