-- 01-init.sql: Paplašinājumi un pamatstruktūra ĢIS karšu platformai

-- 1. Iespējot PostGIS telpiskos paplašinājumus
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- 2. Iespējot trigramu un latviešu burtu normalizācijas atbalstu meklēšanai
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Palīgfunkcija latviešu teksta meklēšanai bez garumzīmēm/mīkstinājuma zīmēm
CREATE OR REPLACE FUNCTION lv_normalize(input_text text)
RETURNS text AS $$
    SELECT lower(unaccent(input_text));
$$ LANGUAGE sql IMMUTABLE STRICT;

-- 3. Bāzes tabula: Zemes vienības (Kadastrs)
CREATE TABLE IF NOT EXISTS public.parcels (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(11) UNIQUE NOT NULL,      -- 11 zīmju kadastra apzīmējums (piem., 01000670001)
    address TEXT,                          -- Primārā adrese
    area_m2 NUMERIC(14, 2),                -- Zemes platība m²
    status VARCHAR(50),                    -- Īpašuma statuss
    cadastral_value NUMERIC(14, 2),        -- Kadastrālā vērtība EUR
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    geom GEOMETRY(MultiPolygon, 3857)      -- Web Mercator projekcija Martin flīzēm
);

-- Telpiskais un meklēšanas indeksi
CREATE INDEX IF NOT EXISTS idx_parcels_geom ON public.parcels USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_parcels_code ON public.parcels (code);
CREATE INDEX IF NOT EXISTS idx_parcels_address_trgm ON public.parcels USING GIN (address gin_trgm_ops);

-- 4. Bāzes tabula: Būvju kontūras
CREATE TABLE IF NOT EXISTS public.buildings (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(14) UNIQUE NOT NULL,      -- Būves kadastra apzīmējums (piem., 01000670001001)
    parcel_code VARCHAR(11),               -- Saistītā zemes vienība
    floors INT,                            -- Virszemes stāvi
    construction_year INT,                 -- Ekspluatācijā pieņemšanas gads
    depreciation_pct INT,                  -- Fiziskais nolietojums %
    material TEXT,                         -- Ārsienu materiāls
    geom GEOMETRY(MultiPolygon, 3857)
);

CREATE INDEX IF NOT EXISTS idx_buildings_geom ON public.buildings USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_buildings_code ON public.buildings (code);
CREATE INDEX IF NOT EXISTS idx_buildings_parcel ON public.buildings (parcel_code);

-- 5. Bāzes tabula: VZD Nekustamā īpašuma tirgus darījumi (NĪTB)
CREATE TABLE IF NOT EXISTS public.transactions (
    id BIGSERIAL PRIMARY KEY,
    deal_id BIGINT UNIQUE,                 -- VZD darījuma ID
    cadastre_code VARCHAR(11),             -- Saistītais kadastra kods
    deal_date DATE NOT NULL,               -- Darījuma datums
    amount_eur NUMERIC(14, 2) NOT NULL,    -- Summa EUR
    area_m2 NUMERIC(12, 2),                -- Platība
    price_per_m2 NUMERIC(10, 2),           -- Cena EUR/m²
    property_type VARCHAR(20),             -- 'zv' (zeme), 'zvb' (zeme ar būvi), 'tg' (telpu grupa/dzīvoklis)
    address TEXT,
    geom GEOMETRY(Point, 3857)             -- Punkta koordinātas kartē
);

CREATE INDEX IF NOT EXISTS idx_transactions_geom ON public.transactions USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_transactions_deal_date ON public.transactions (deal_date);
CREATE INDEX IF NOT EXISTS idx_transactions_cadastre ON public.transactions (cadastre_code);

-- 6. Bāzes tabula: Valsts adrešu reģistrs (VAR)
CREATE TABLE IF NOT EXISTS public.addresses (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(20) UNIQUE,
    address TEXT NOT NULL,
    geom GEOMETRY(Point, 3857)
);

CREATE INDEX IF NOT EXISTS idx_addresses_geom ON public.addresses USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_addresses_trgm ON public.addresses USING GIN (address gin_trgm_ops);

-- 7. Pārbaudes dati (Demo zemes vienība un darījums Vecrīgā pie Doma baznīcas),
-- lai Martin tūlīt pēc startēšanas katalogā /catalog uzrādītu tabulas un datus
INSERT INTO public.parcels (code, address, area_m2, status, cadastral_value, geom)
VALUES (
    '01000070001',
    'Doma laukums 1, Rīga',
    3500.00,
    'nekustamais īpašums',
    1250000.00,
    ST_Multi(ST_Transform(ST_GeomFromText('POLYGON((24.1042 56.9491, 24.1055 56.9491, 24.1055 56.9499, 24.1042 56.9499, 24.1042 56.9491))', 4326), 3857))
) ON CONFLICT (code) DO NOTHING;

INSERT INTO public.transactions (deal_id, cadastre_code, deal_date, amount_eur, area_m2, price_per_m2, property_type, address, geom)
VALUES (
    999001,
    '01000070001',
    '2026-06-15',
    450000.00,
    180.00,
    2500.00,
    'tg',
    'Doma laukums 1, Rīga',
    ST_Transform(ST_SetSRID(ST_MakePoint(24.1048, 56.9495), 4326), 3857)
) ON CONFLICT (deal_id) DO NOTHING;
