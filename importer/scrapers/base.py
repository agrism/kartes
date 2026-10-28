"""
importer/scrapers/base.py - Bāzes modelis un skreiperu abstrakcija
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Generator, List, Optional, Dict, Any
import re

@dataclass
class ListingItem:
    source: str                          # ss.com, city24.lv, pp.lv, izsoles.ta.gov.lv
    external_id: str                     # Unikālais portāla ID
    deal_type: str = "sell"              # sell, rent
    category: str = "flats"              # flats, houses, plots, commercial, wood, other
    title: str = ""
    description: str = ""
    url: str = ""
    price: Optional[float] = None
    currency: str = "EUR"
    price_per_m2: Optional[float] = None
    area_m2: Optional[float] = None
    rooms: Optional[int] = None
    floor: Optional[int] = None
    total_floors: Optional[int] = None
    series: Optional[str] = None
    house_type: Optional[str] = None
    address_text: Optional[str] = None
    town: Optional[str] = None
    district: Optional[str] = None
    cadastre_code: Optional[str] = None
    images: List[str] = field(default_factory=list)
    features: Dict[str, Any] = field(default_factory=dict)
    lng: Optional[float] = None
    lat: Optional[float] = None
    published_at: Optional[datetime] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "external_id": self.external_id,
            "deal_type": self.deal_type,
            "category": self.category,
            "title": self.title,
            "description": self.description,
            "url": self.url,
            "price": self.price,
            "currency": self.currency,
            "price_per_m2": self.price_per_m2,
            "area_m2": self.area_m2,
            "rooms": self.rooms,
            "floor": self.floor,
            "total_floors": self.total_floors,
            "series": self.series,
            "house_type": self.house_type,
            "address_text": self.address_text,
            "town": self.town,
            "district": self.district,
            "cadastre_code": self.cadastre_code,
            "images": self.images,
            "features": self.features,
            "lng": self.lng,
            "lat": self.lat,
            "published_at": self.published_at.isoformat() if self.published_at else None,
        }

class BaseScraper(ABC):
    name: str = "base"

    @abstractmethod
    def scrape(self, limit: Optional[int] = None) -> Generator[ListingItem, None, None]:
        """
        Ģenerē ListingItem objektus
        """
        pass

    @staticmethod
    def safe_float(val: Any, default: Optional[float] = None) -> Optional[float]:
        if val is None or val == "":
            return default
        try:
            s = str(val).strip().replace("\xa0", "").replace(" ", "")
            # Ja ir tūkstošu atdalītājs ar komatu: piemēram 89,950 vai 1,350
            s = re.sub(r"(\d{1,3}),(\d{3})(?=\D|$)", r"\1\2", s)
            s = s.replace(",", ".")
            num_match = re.search(r"[-+]?[0-9]*\.?[0-9]+", s)
            if num_match:
                return float(num_match.group(0))
            return default
        except Exception:
            return default

    @staticmethod
    def safe_int(val: Any, default: Optional[int] = None) -> Optional[int]:
        if val is None or val == "":
            return default
        try:
            cleaned = str(val).replace(" ", "").replace("\xa0", "")
            num_match = re.search(r"[-+]?[0-9]+", cleaned)
            if num_match:
                return int(num_match.group(0))
            return default
        except Exception:
            return default

    @staticmethod
    def parse_floor(floor_str: Optional[str]) -> (Optional[int], Optional[int]):
        if not floor_str:
            return None, None
        try:
            parts = str(floor_str).split("/")
            if len(parts) == 2:
                return BaseScraper.safe_int(parts[0]), BaseScraper.safe_int(parts[1])
            elif len(parts) == 1:
                return BaseScraper.safe_int(parts[0]), None
        except Exception:
            pass
        return None, None
