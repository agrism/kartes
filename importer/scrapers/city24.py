"""
importer/scrapers/city24.py - City24.lv nekustamā īpašuma skreiperis
Izmanto oficiālo City24 REST API, lai iegūtu svaigos sludinājumus visā Latvijā.
"""

import time
import requests
from datetime import datetime
from typing import Generator, Optional, List, Dict, Any
from .base import BaseScraper, ListingItem

CITY24_API_URL = "https://api.city24.lv/lv_LV/search/realties"

CATEGORY_MAPPING = {
    "Apartment": "flats",
    "House": "houses",
    "Part of a house": "houses",
    "Summer house": "houses",
    "Plot": "plots",
    "Commercial": "commercial",
    "Garage": "other",
    "Forest": "wood",
}

class City24Scraper(BaseScraper):
    name = "city24"

    def __init__(self, request_delay: float = 0.3):
        self.delay = request_delay
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "lv,en-US;q=0.7,en;q=0.3",
        })

    def scrape(self, limit: Optional[int] = None) -> Generator[ListingItem, None, None]:
        """
        Iegūst sludinājumus no City24 API ar lapošanu.
        """
        count = 0
        page_size = 50
        offset = 0

        while True:
            url = f"{CITY24_API_URL}?limit={page_size}&offset={offset}"
            try:
                resp = self.session.get(url, timeout=25)
                if resp.status_code != 200:
                    print(f"⚠️ City24 API atgrieza statusu {resp.status_code}")
                    break

                items: List[Dict[str, Any]] = resp.json()
                if not items or not isinstance(items, list):
                    break

                for raw in items:
                    item = self._parse_item(raw)
                    if item:
                        yield item
                        count += 1
                        if limit and count >= limit:
                            return

                offset += len(items)
                if len(items) < page_size:
                    # Sasniegtas pēdējās lapas
                    break

                if self.delay > 0:
                    time.sleep(self.delay)

            except Exception as e:
                print(f"❌ Kļūda ielādējot City24 lapu pie offset={offset}: {e}")
                break

    def _parse_item(self, raw: Dict[str, Any]) -> Optional[ListingItem]:
        ext_id = str(raw.get("id") or raw.get("friendly_id") or "")
        if not ext_id:
            return None

        # Darījuma tips: /transaction_types/1 (pārdod) vai /transaction_types/2 (izīrē)
        tx_type = str(raw.get("transaction_type") or "")
        deal_type = "rent" if ("2" in tx_type or "rent" in tx_type.lower()) else "sell"

        unit_type = raw.get("unit_type") or ""
        category = CATEGORY_MAPPING.get(unit_type, "flats")

        # Cena un platība
        price = self.safe_float(raw.get("price"))
        price_per_m2 = self.safe_float(raw.get("price_per_unit"))
        area = self.safe_float(raw.get("property_size") or raw.get("lot_size"))
        rooms = self.safe_int(raw.get("room_count"))

        # Atribūti
        attrs = raw.get("attributes") or {}
        floor = self.safe_int(attrs.get("FLOOR"))
        total_floors = self.safe_int(attrs.get("TOTAL_FLOORS"))
        house_type = None
        if isinstance(attrs.get("HOUSE_TYPE"), list) and attrs["HOUSE_TYPE"]:
            house_type = str(attrs["HOUSE_TYPE"][0])
        elif isinstance(attrs.get("HOUSE_TYPE"), str):
            house_type = attrs["HOUSE_TYPE"]

        # Adrese
        addr_obj = raw.get("address") or {}
        street = addr_obj.get("street_name") or ""
        house_num = addr_obj.get("house_number") or ""
        apt_num = addr_obj.get("apartment_number") or ""
        city = addr_obj.get("city_name") or ""
        district = addr_obj.get("district_name") or addr_obj.get("parish_name") or ""
        county = addr_obj.get("county_name") or ""

        addr_parts = []
        if street:
            st_text = street
            if house_num:
                st_text += f" {house_num}"
            if apt_num:
                st_text += f"-{apt_num}"
            addr_parts.append(st_text)
        if district and district not in addr_parts:
            addr_parts.append(district)
        if city and city not in addr_parts:
            addr_parts.append(city)
        if county and county not in addr_parts:
            addr_parts.append(county)

        full_addr = ", ".join(addr_parts) if addr_parts else (raw.get("guid") or "Nekustamais īpašums")

        # Koordinātas
        lat = self.safe_float(raw.get("latitude"))
        lng = self.safe_float(raw.get("longitude"))

        # Kadastra kods (ja ir aizpildīts sludinājumā)
        cad_code = addr_obj.get("cadaster_number") or None
        if cad_code:
            cad_code = str(cad_code).strip().replace("-", "").replace(" ", "")
            if len(cad_code) != 11:
                cad_code = None

        # Attēli
        images = []
        for img in raw.get("images") or []:
            if isinstance(img, str):
                # Aizstājam {fmt:em} ar 11 kvalitatīvam attēlam
                img_url = img.replace("{fmt:em}", "11")
                images.append(img_url)

        # Publicēšanas datums
        published_at = None
        date_str = raw.get("date_published")
        if date_str:
            try:
                published_at = datetime.fromisoformat(date_str)
            except Exception:
                pass

        friendly_id = raw.get("friendly_id") or ext_id
        url = f"https://www.city24.lv/lv/nekustamais-ipasums/{friendly_id}"

        # Slogani / nosaukums
        slogans = raw.get("slogans") or {}
        lv_slogan = (slogans.get("lv_LV") or {}).get("slogan") or ""
        title = lv_slogan or f"{unit_type or 'Īpašums'} {full_addr}"

        return ListingItem(
            source="city24",
            external_id=ext_id,
            deal_type=deal_type,
            category=category,
            title=title,
            description=lv_slogan,
            url=url,
            price=price,
            price_per_m2=price_per_m2,
            area_m2=area,
            rooms=rooms,
            floor=floor,
            total_floors=total_floors,
            house_type=house_type,
            address_text=full_addr,
            town=city or county,
            district=district,
            cadastre_code=cad_code,
            images=images,
            features=attrs,
            lng=lng,
            lat=lat,
            published_at=published_at,
        )
