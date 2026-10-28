-- 02-listings.sql: Multi-source nekustamā īpašuma sludinājumi un cenu vēsture

CREATE TABLE IF NOT EXISTS public.listings (
    id BIGSERIAL PRIMARY KEY,
    source VARCHAR(50) NOT NULL DEFAULT 'ss.com',       -- Portāls: 'ss.com', 'city24.lv', 'pp.lv', 'izsoles.ta.gov.lv' u.c.
    external_id VARCHAR(100) NOT NULL,                  -- Sludinājuma unikālais ID avota portālā
    deal_type VARCHAR(30) NOT NULL DEFAULT 'sell',      -- 'sell', 'rent', 'auction', 'lease'
    category VARCHAR(50) NOT NULL DEFAULT 'flats',      -- 'flats', 'houses', 'land', 'commercial', 'garages'
    title TEXT,                                         -- Virsraksts / nosaukums
    description TEXT,                                   -- Pilns vai saīsināts apraksts
    url TEXT NOT NULL,                                  -- Tiešā saite uz sludinājumu
    price NUMERIC(14, 2),                               -- Pašreizējā cena EUR
    first_price NUMERIC(14, 2),                         -- Sākotnējā cena EUR
    currency VARCHAR(10) DEFAULT 'EUR',
    price_per_m2 NUMERIC(10, 2),                        -- Cena par m²
    area_m2 NUMERIC(12, 2),                             -- Platība m²
    rooms INT,                                          -- Istabu skaits
    floor INT,                                          -- Stāvs
    total_floors INT,                                   -- Kopējais stāvu skaits ēkā
    series VARCHAR(50),                                 -- Sērija (piem., '103.', '119.', 'Pirmskara', 'Jaunais')
    house_type VARCHAR(50),                             -- Ēkas tips (ķieģeļu, paneļu, koka utt.)
    address_text TEXT,                                  -- Sludinājumā norādītā adrese
    town VARCHAR(100),                                  -- Pilsēta / ciems
    district VARCHAR(100),                              -- Pagasts / novads / rajons
    cadastre_code VARCHAR(15),                          -- Piesaistītā kadastra zemes vienība (11 zīmes)
    images JSONB DEFAULT '[]'::jsonb,                   -- Bilžu URL masīvs
    features JSONB DEFAULT '{}'::jsonb,                 -- Papildu atribūti (apkure, ērtības, stāvvieta utt.)
    geom GEOMETRY(Point, 4326),                         -- Ģeogrāfiskais punkts (WGS84)
    geom_3857 GEOMETRY(Point, 3857),                    -- Web Mercator punkts flīzēm/ātrdarbībai
    published_at TIMESTAMP WITH TIME ZONE,              -- Publicēšanas datums portālā
    first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    days_on_market INT DEFAULT 1,                       -- Dienas tirgū
    is_active BOOLEAN DEFAULT TRUE,                     -- Vai sludinājums ir aktīvs
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_listings_source_external_id UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_geom ON public.listings USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_listings_geom_3857 ON public.listings USING GIST (geom_3857);
CREATE INDEX IF NOT EXISTS idx_listings_cadastre ON public.listings (cadastre_code);
CREATE INDEX IF NOT EXISTS idx_listings_source ON public.listings (source);
CREATE INDEX IF NOT EXISTS idx_listings_active ON public.listings (is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_listings_price ON public.listings (price);
CREATE INDEX IF NOT EXISTS idx_listings_category ON public.listings (category);
CREATE INDEX IF NOT EXISTS idx_listings_deal_type ON public.listings (deal_type);

CREATE TABLE IF NOT EXISTS public.listing_price_changes (
    id BIGSERIAL PRIMARY KEY,
    listing_id BIGINT NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
    change_date DATE NOT NULL,
    old_price NUMERIC(14, 2) NOT NULL,
    new_price NUMERIC(14, 2) NOT NULL,
    delta_amount NUMERIC(14, 2) NOT NULL,               -- new_price - old_price (negatīvs, ja samazināta)
    delta_percent NUMERIC(6, 2) NOT NULL,               -- procentuālā izmaiņa
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_price_changes_listing ON public.listing_price_changes (listing_id);
CREATE INDEX IF NOT EXISTS idx_price_changes_date ON public.listing_price_changes (change_date);
