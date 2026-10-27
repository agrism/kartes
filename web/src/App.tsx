import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';

interface EnergyCertInfo {
  class: string;
  heating_kwh_m2?: number;
  valid_until?: string;
  status?: string;
}

interface PollutionNearbyInfo {
  name: string;
  category: string;
  site_type: string;
  distance_m: number;
}

interface ParcelInfo {
  code: string;
  address: string;
  area_m2: number;
  status: string;
  cadastral_value: number;
  energy_cert?: EnergyCertInfo | null;
  pollution_nearby?: PollutionNearbyInfo[];
}

interface Transaction {
  deal_id: number;
  cadastre_code: string;
  deal_date: string;
  amount_eur: number;
  area_m2: number;
  price_per_m2: number;
  property_type: string;
  address: string;
}

interface Suggestion {
  code: string;
  address: string;
  lng?: number;
  lat?: number;
}

function getEndpoints() {
  const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return {
    apiBase: (import.meta as any).env.VITE_API_URL || (isLocal ? 'http://localhost:8090' : origin),
    tilesBase: (import.meta as any).env.VITE_TILES_URL || (isLocal ? 'http://localhost:3000' : `${origin}/tiles`),
  };
}

export default function App() {
  const { apiBase: API_BASE, tilesBase: TILES_BASE } = getEndpoints();
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedParcel, setSelectedParcel] = useState<ParcelInfo | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);

  // Slāņu redzamība
  const [showParcels, setShowParcels] = useState(true);
  const [showBuildings, setShowBuildings] = useState(true);
  const [showTransactions, setShowTransactions] = useState(true);
  const [showFloods, setShowFloods] = useState(false);
  const [showEnergy, setShowEnergy] = useState(true);
  const [showPollution, setShowPollution] = useState(true);
  const [isSatellite, setIsSatellite] = useState(false);

  // Slāņu panelis (atvērts/aizvērts) - desktopā pēc noklusējuma atvērts, mobilajā aizvērts
  const [isLayersOpen, setIsLayersOpen] = useState(
    typeof window !== 'undefined' ? window.innerWidth > 820 : true
  );

  const activeLayersCount =
    (showParcels ? 1 : 0) +
    (showBuildings ? 1 : 0) +
    (showTransactions ? 1 : 0) +
    (showEnergy ? 1 : 0) +
    (showPollution ? 1 : 0) +
    (showFloods ? 1 : 0) +
    (isSatellite ? 1 : 0);

  const clearAllLayers = () => {
    setShowParcels(false);
    setShowBuildings(false);
    setShowTransactions(false);
    setShowEnergy(false);
    setShowPollution(false);
    setShowFloods(false);
    setIsSatellite(false);
  };

  const handleLocate = () => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          map.current?.flyTo({
            center: [pos.coords.longitude, pos.coords.latitude],
            zoom: 17,
            essential: true,
          });
        },
        (err) => {
          console.warn('Geolocation error:', err);
          alert('Nevarēja noteikt atrašanās vietu. Pārbaudiet pārlūka GPS piekļuves atļaujas.');
        },
        { enableHighAccuracy: true }
      );
    }
  };

  // Inicializē MapLibre karti
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    const m = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: [24.1048, 56.9495], // Vecrīga / Centrs
      zoom: 16,
      attributionControl: false,
    });

    m.on('load', () => {
      // 0. Satelīta aerofoto pamatne (Esri World Imagery)
      m.addSource('esri-satellite', {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
      });

      m.addLayer({
        id: 'satellite-layer',
        type: 'raster',
        source: 'esri-satellite',
        layout: { visibility: 'none' },
      });

      // 1. ZEMES VIENĪBAS (Parcels)
      m.addSource('parcels', {
        type: 'vector',
        tiles: [`${TILES_BASE}/parcels/{z}/{x}/{y}`],
        minzoom: 12,
        maxzoom: 22,
      });

      m.addLayer({
        id: 'parcels-fill',
        type: 'fill',
        source: 'parcels',
        'source-layer': 'parcels',
        paint: {
          'fill-color': '#1b6b3a',
          'fill-opacity': 0.12,
        },
      });

      m.addLayer({
        id: 'parcels-line',
        type: 'line',
        source: 'parcels',
        'source-layer': 'parcels',
        paint: {
          'line-color': '#1b6b3a',
          'line-width': 1.5,
          'line-opacity': 0.8,
        },
      });

      // 2. ĒKAS (Buildings)
      m.addSource('buildings', {
        type: 'vector',
        tiles: [`${TILES_BASE}/buildings/{z}/{x}/{y}`],
        minzoom: 14,
        maxzoom: 22,
      });

      m.addLayer({
        id: 'buildings-fill',
        type: 'fill',
        source: 'buildings',
        'source-layer': 'buildings',
        paint: {
          'fill-color': '#475569',
          'fill-opacity': 0.7,
        },
      });

      m.addLayer({
        id: 'buildings-line',
        type: 'line',
        source: 'buildings',
        'source-layer': 'buildings',
        paint: {
          'line-color': '#1e293b',
          'line-width': 1,
          'line-opacity': 0.9,
        },
      });

      // 3. DARĪJUMI (Transactions)
      m.addSource('transactions', {
        type: 'vector',
        tiles: [`${TILES_BASE}/transactions/{z}/{x}/{y}`],
        minzoom: 12,
        maxzoom: 22,
      });

      m.addLayer({
        id: 'transactions-circle',
        type: 'circle',
        source: 'transactions',
        'source-layer': 'transactions',
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            12, 3,
            15, 6,
            18, 9,
          ],
          'circle-color': [
            'interpolate', ['linear'], ['to-number', ['get', 'price_per_m2'], 500],
            50, '#10b981',    // Zema cena / lauki
            500, '#0284c7',   // Vidēja cena
            1500, '#f59e0b',  // Premium
            3000, '#ef4444',  // Ekskluzīvs
          ],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.85,
        },
      });

      // 4. BVKB ĒKU ENERGOSERTIFIKĀTI
      m.addSource('energy', {
        type: 'vector',
        tiles: [`${TILES_BASE}/energy_certificates/{z}/{x}/{y}`],
        minzoom: 11,
        maxzoom: 22,
      });

      m.addLayer({
        id: 'energy-dots',
        type: 'circle',
        source: 'energy',
        'source-layer': 'energy_certificates',
        minzoom: 12,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3.5, 15, 6, 18, 9],
          'circle-color': [
            'match', ['coalesce', ['get', 'energy_class'], ''],
            'A+', '#16a34a',
            'A', '#16a34a',
            'B', '#65a30d',
            'C', '#ca8a04',
            'D', '#ea580c',
            'E', '#e11d48',
            'F', '#b91c1c',
            'G', '#991b1b',
            '#94a3b8',
          ],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9,
        },
      });

      // 5. VVD PIESĀRŅOTĀS VIETAS
      m.addSource('pollution', {
        type: 'vector',
        tiles: [`${TILES_BASE}/pollution_sites/{z}/{x}/{y}`],
        minzoom: 8,
        maxzoom: 22,
      });

      m.addLayer({
        id: 'pollution-dots',
        type: 'circle',
        source: 'pollution',
        'source-layer': 'pollution_sites',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 14, 7, 18, 10],
          'circle-color': [
            'match', ['coalesce', ['get', 'category'], ''],
            'Piesārņota vieta', '#dc2626',
            '#ca8a04',
          ],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9,
        },
      });

      // Interaktivitāte kursoram
      const interactiveLayers = ['parcels-fill', 'buildings-fill', 'transactions-circle', 'energy-dots', 'pollution-dots'];
      interactiveLayers.forEach((layer) => {
        m.on('mouseenter', layer, () => {
          m.getCanvas().style.cursor = 'pointer';
        });
        m.on('mouseleave', layer, () => {
          m.getCanvas().style.cursor = '';
        });
      });

      // Klikšķa apstrāde
      m.on('click', 'transactions-circle', (e) => {
        if (!e.features || !e.features[0]) return;
        const cadCode = e.features[0].properties?.cadastre_code;
        if (cadCode) {
          fetchParcelDetails(cadCode);
        }
      });

      m.on('click', 'buildings-fill', (e) => {
        if (!e.features || !e.features[0]) return;
        const parcelCode = e.features[0].properties?.parcel_code;
        if (parcelCode) {
          fetchParcelDetails(parcelCode);
        }
      });

      m.on('click', 'parcels-fill', (e) => {
        if (!e.features || !e.features[0]) return;
        const code = e.features[0].properties?.code;
        if (code) {
          fetchParcelDetails(code);
        }
      });

      m.on('click', 'energy-dots', (e) => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const pCode = p?.parcel_code || p?.building_code;
        new maplibregl.Popup()
          .setLngLat(e.lngLat)
          .setHTML(`
            <div style="font-family: inherit; padding: 4px;">
              <div style="font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 700;">Ēkas energosertifikāts</div>
              <div style="display: flex; align-items: center; gap: 8px; margin: 6px 0;">
                <span style="background: #16a34a; color: white; font-weight: 800; padding: 2px 8px; border-radius: 4px; font-size: 14px;">${p?.energy_class || '—'} klase</span>
                <span style="font-size: 13px; font-weight: 600;">${p?.heating_kwh_m2 ? Math.round(p.heating_kwh_m2) + ' kWh/m² gadā' : ''}</span>
              </div>
              <div style="font-size: 11px; color: #475569;">${p?.address || ''}</div>
              <div style="font-size: 11px; color: #64748b; margin-top: 4px;">Statuss: ${p?.status || ''}</div>
            </div>
          `)
          .addTo(m);
        if (pCode) fetchParcelDetails(pCode.slice(0, 11));
      });

      m.on('click', 'pollution-dots', (e) => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const isHigh = p?.category === 'Piesārņota vieta';
        new maplibregl.Popup()
          .setLngLat(e.lngLat)
          .setHTML(`
            <div style="font-family: inherit; padding: 4px;">
              <div style="font-size: 11px; text-transform: uppercase; color: ${isHigh ? '#dc2626' : '#ca8a04'}; font-weight: 800;">
                ⚠️ ${p?.category || 'Piesārņota vieta'}
              </div>
              <div style="font-weight: 700; font-size: 13px; margin: 4px 0;">${p?.name || 'VVD objekts'}</div>
              <div style="font-size: 12px; color: #475569;">${p?.site_type || ''}</div>
              <div style="font-size: 11px; color: #64748b; margin-top: 2px;">${p?.address || ''} (${p?.place || ''})</div>
            </div>
          `)
          .addTo(m);
      });
    });

    map.current = m;

    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // Slāņu redzamības pārslēgšana
  useEffect(() => {
    if (!map.current || !map.current.isStyleLoaded()) return;
    const visibility = (show: boolean) => (show ? 'visible' : 'none');

    if (map.current.getLayer('satellite-layer')) {
      map.current.setLayoutProperty('satellite-layer', 'visibility', isSatellite ? 'visible' : 'none');
    }
    if (map.current.getLayer('parcels-fill')) {
      map.current.setLayoutProperty('parcels-fill', 'visibility', visibility(showParcels));
      map.current.setLayoutProperty('parcels-line', 'visibility', visibility(showParcels));
    }
    if (map.current.getLayer('buildings-fill')) {
      map.current.setLayoutProperty('buildings-fill', 'visibility', visibility(showBuildings));
      map.current.setLayoutProperty('buildings-line', 'visibility', visibility(showBuildings));
    }
    if (map.current.getLayer('transactions-circle')) {
      map.current.setLayoutProperty('transactions-circle', 'visibility', visibility(showTransactions));
    }
    if (map.current.getLayer('energy-dots')) {
      map.current.setLayoutProperty('energy-dots', 'visibility', visibility(showEnergy));
    }
    if (map.current.getLayer('pollution-dots')) {
      map.current.setLayoutProperty('pollution-dots', 'visibility', visibility(showPollution));
    }
  }, [showParcels, showBuildings, showTransactions, showFloods, showEnergy, showPollution, isSatellite]);

  // Iegūst zemes vienības datus un darījumus no Go API
  const fetchParcelDetails = async (code: string) => {
    if (!code) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/parcel-info?code=${encodeURIComponent(code)}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedParcel(data);
      } else {
        // Ja nav zemes vienības, rādām vismaz kodu
        setSelectedParcel({
          code,
          address: '',
          area_m2: 0,
          status: 'Reģistrēts',
          cadastral_value: 0,
        });
      }

      // Ielādē darījumus
      const txRes = await fetch(`${API_BASE}/api/transactions?cadastre=${encodeURIComponent(code)}`);
      if (txRes.ok) {
        const txData = await txRes.json();
        setTransactions(txData);
      } else {
        setTransactions([]);
      }
    } catch (err) {
      console.error('Kļūda ielādējot īpašumu:', err);
    } finally {
      setLoading(false);
    }
  };

  // Adrešu meklēšanas autofinišs (debounce)
  useEffect(() => {
    if (searchQuery.trim().length < 2) {
      setSuggestions([]);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/address-suggest?q=${encodeURIComponent(searchQuery)}`);
        if (res.ok) {
          const list = await res.json();
          setSuggestions(list);
        }
      } catch (e) {
        console.error(e);
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleSelectSuggestion = (s: Suggestion) => {
    setSearchQuery(s.address);
    setSuggestions([]);

    if (searchInputRef.current) {
      searchInputRef.current.blur();
    }

    if (s.lng && s.lat && map.current) {
      map.current.flyTo({
        center: [s.lng, s.lat],
        zoom: 18,
        essential: true,
      });
    }

    if (s.code) {
      fetchParcelDetails(s.code);
    }
  };

  return (
    <>
      {/* 1. TOP NAVBAR (Kā oriģinālajā kadastrakarte.lv) */}
      <header id="navbar">
        <div className="nav-inner">
          <a href="/" className="nav-logo">
            <div className="nav-logo-icon">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#7a1f16" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                <circle cx="12" cy="9" r="2.5" fill="#7a1f16"/>
              </svg>
            </div>
            <span className="nav-logo-text">Kadastra Karte</span>
          </a>

          <nav className="nav-links">
            <a href="/" className="active">Īpašumu karte</a>
            <a href="#darijumi">Darījumu statistika</a>
            <a href="#par">Par projektu</a>
          </nav>

          <div className="nav-actions">
            <button
              type="button"
              className={`nav-btn outline ${isSatellite ? 'active-sat' : ''}`}
              onClick={() => setIsSatellite(!isSatellite)}
            >
              🛰️ {isSatellite ? 'Pamatkarte' : 'Aerofoto'}
            </button>
            <div className="nav-lang">
              <button type="button" className="nav-lang-btn active">LV</button>
            </div>
          </div>
        </div>
      </header>

      {/* 2. MAP CONTAINER */}
      <div id="map" ref={mapContainer} />

      {/* 3. MOBILE OVERLAY */}
      <div
        id="mob-layers-overlay"
        className={isLayersOpen ? 'open' : ''}
        onClick={() => setIsLayersOpen(false)}
      />

      {/* 4. KREISĀ SLEJA: MEKLĒTĀJS UN SLĀŅU KARTIŅA (#map-left-col) */}
      <div id="map-left-col">
        <div id="search-wrap">
          <div id="search-box">
            <span id="search-icon">🔍</span>
            <input
              ref={searchInputRef}
              id="search-input"
              type="text"
              placeholder="Meklēt adresi, pilsētu, novadu..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoComplete="off"
              spellCheck="false"
            />
            {searchQuery && (
              <span
                id="search-clear"
                onClick={() => {
                  setSearchQuery('');
                  setSuggestions([]);
                }}
              >
                ✕
              </span>
            )}
          </div>

          {suggestions.length > 0 && (
            <div id="search-results">
              {suggestions.map((s, idx) => (
                <div
                  key={`${s.code}-${idx}`}
                  className="search-item"
                  onClick={() => handleSelectSuggestion(s)}
                >
                  <div className="search-item-main">{s.address}</div>
                  <div className="search-item-sub mono">{s.code}</div>
                </div>
              ))}
            </div>
          )}

          {/* Mobilā slāņu atvēršanas poga */}
          <div
            id="mob-layers-trigger"
            onClick={() => setIsLayersOpen(!isLayersOpen)}
            role="button"
            aria-label="Slāņi"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3a352e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            <span id="mob-layers-label">Slāņi</span>
            {activeLayersCount > 0 && (
              <span id="mob-layers-badge">{activeLayersCount}</span>
            )}
          </div>
        </div>

        {/* ORIĢINĀLĀ SLĀŅU KARTIŅA (#layer-card) */}
        <div id="layer-card" className={isLayersOpen ? 'mob-open' : ''}>
          {!isLayersOpen ? (
            /* SAKĻAUTĀ KARTIŅA */
            <div id="lc-collapsed" onClick={() => setIsLayersOpen(true)}>
              <div className={activeLayersCount > 0 ? "lc-badge-active" : "lc-badge-empty"}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={activeLayersCount > 0 ? "#fff" : "#6E6458"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
              </div>
              <div id="lc-info">
                <div id="lc-title">Slāņi</div>
                <div id="lc-sub">{activeLayersCount} aktīvi slāņi</div>
              </div>
              <div id="lc-chevron-r">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8A7F72" strokeWidth="2.5">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
            </div>
          ) : (
            /* IZVĒRSTĀ KARTIŅA */
            <div id="lc-expanded">
              <div id="lc-exp-header">
                <div className={activeLayersCount > 0 ? "lc-badge-active" : "lc-badge-empty"} style={{ width: 38, height: 38, borderRadius: 12 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={activeLayersCount > 0 ? "#fff" : "#6E6458"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                  </svg>
                </div>
                <div id="lc-exp-text">
                  <div id="lc-exp-title">Slāņi</div>
                  <div id="lc-exp-status">{activeLayersCount} aktīvi slāņi</div>
                </div>
                {activeLayersCount > 0 && (
                  <button id="lc-clear-btn" type="button" onClick={clearAllLayers}>
                    Notīrīt
                  </button>
                )}
                <button id="lc-collapse-btn" type="button" onClick={() => setIsLayersOpen(false)} title="Sakļaut slāņus">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6E6458" strokeWidth="2">
                    <polyline points="18 15 12 9 6 15" />
                  </svg>
                </button>
                <button id="lc-mob-close" type="button" onClick={() => setIsLayersOpen(false)}>✕</button>
              </div>

              {/* Slāņu kategorijas */}
              <div id="lc-cats">
                {/* 1. KADASTRS UN ĒKAS */}
                <div className="lc-cat open">
                  <div className="lc-cat-hdr">
                    <div className="lc-tile" style={{ background: '#eaf4ee', color: '#1b6b3a' }}>🏛️</div>
                    <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>Kadastrs un ēkas</span>
                  </div>
                  <div className="lc-layers">
                    <div className={`lc-row ${showParcels ? 'on' : ''}`} onClick={() => setShowParcels(!showParcels)}>
                      <div className="lc-swatch" style={{ background: '#1b6b3a' }} />
                      <span className="lc-row-name">Zemes vienības (robežas)</span>
                      <button className={`lc-tog ${showParcels ? 'on' : ''}`} type="button" tabIndex={-1}>
                        <div className="lc-tog-k" />
                      </button>
                    </div>
                    <div className={`lc-row ${showBuildings ? 'on' : ''}`} onClick={() => setShowBuildings(!showBuildings)}>
                      <div className="lc-swatch" style={{ background: '#334155' }} />
                      <span className="lc-row-name">Ēkas un būves</span>
                      <button className={`lc-tog ${showBuildings ? 'on' : ''}`} type="button" tabIndex={-1}>
                        <div className="lc-tog-k" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* 2. NEKUSTAMĀ ĪPAŠUMA DARĪJUMI */}
                <div className="lc-cat open" style={{ marginTop: 8 }}>
                  <div className="lc-cat-hdr">
                    <div className="lc-tile" style={{ background: '#e0f2fe', color: '#0284c7' }}>💶</div>
                    <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>Darījumi (VZD)</span>
                  </div>
                  <div className="lc-layers">
                    <div className={`lc-row ${showTransactions ? 'on' : ''}`} onClick={() => setShowTransactions(!showTransactions)}>
                      <div className="lc-swatch" style={{ background: '#0284c7' }} />
                      <span className="lc-row-name">Cenas un darījumu vēsture</span>
                      <button className={`lc-tog ${showTransactions ? 'on' : ''}`} type="button" tabIndex={-1}>
                        <div className="lc-tog-k" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* 3. ENERGOEFEKTIVITĀTE */}
                <div className="lc-cat open" style={{ marginTop: 8 }}>
                  <div className="lc-cat-hdr">
                    <div className="lc-tile" style={{ background: '#fef3c7', color: '#d97706' }}>⚡</div>
                    <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>Energoefektivitāte (BVKB)</span>
                  </div>
                  <div className="lc-layers">
                    <div className={`lc-row ${showEnergy ? 'on' : ''}`} onClick={() => setShowEnergy(!showEnergy)}>
                      <div className="lc-swatch" style={{ background: '#d97706' }} />
                      <span className="lc-row-name">Ēku energosertifikāti (A+ līdz G)</span>
                      <button className={`lc-tog ${showEnergy ? 'on' : ''}`} type="button" tabIndex={-1}>
                        <div className="lc-tog-k" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* 4. VIDES RISKI UN PIESĀRŅOJUMS */}
                <div className="lc-cat open" style={{ marginTop: 8 }}>
                  <div className="lc-cat-hdr">
                    <div className="lc-tile" style={{ background: '#fee2e2', color: '#dc2626' }}>⚠️</div>
                    <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>Vides riski & Piesārņojums</span>
                  </div>
                  <div className="lc-layers">
                    <div className={`lc-row ${showPollution ? 'on' : ''}`} onClick={() => setShowPollution(!showPollution)}>
                      <div className="lc-swatch" style={{ background: '#dc2626' }} />
                      <span className="lc-row-name">VVD Piesārņotās vietas</span>
                      <button className={`lc-tog ${showPollution ? 'on' : ''}`} type="button" tabIndex={-1}>
                        <div className="lc-tog-k" />
                      </button>
                    </div>
                    <div className={`lc-row ${showFloods ? 'on' : ''}`} onClick={() => setShowFloods(!showFloods)}>
                      <div className="lc-swatch" style={{ background: '#0284c7' }} />
                      <span className="lc-row-name">LVĢMC Plūdu riska zonas</span>
                      <button className={`lc-tog ${showFloods ? 'on' : ''}`} type="button" tabIndex={-1}>
                        <div className="lc-tog-k" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* 5. PAMATNE */}
                <div className="lc-cat open" style={{ marginTop: 8 }}>
                  <div className="lc-cat-hdr">
                    <div className="lc-tile" style={{ background: '#f1f5f9', color: '#0f172a' }}>🛰️</div>
                    <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>Pamatkartes</span>
                  </div>
                  <div className="lc-layers">
                    <div className={`lc-row ${isSatellite ? 'on' : ''}`} onClick={() => setIsSatellite(!isSatellite)}>
                      <div className="lc-swatch" style={{ background: '#0f172a' }} />
                      <span className="lc-row-name">Satelīta aerofoto (Esri)</span>
                      <button className={`lc-tog ${isSatellite ? 'on' : ''}`} type="button" tabIndex={-1}>
                        <div className="lc-tog-k" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 5. LABĀS PUSES KARTES POGAS (#sat-btn un #zoom-ctl) */}
      <div
        id="sat-btn"
        className={isSatellite ? 'sat-active' : 'sat-off'}
        onClick={() => setIsSatellite(!isSatellite)}
        title="Pārslēgt aerofoto"
      >
        <div id="sat-btn-label">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 2 7 12 12 22 7 12 2"/>
            <polyline points="2 17 12 22 22 17"/>
            <polyline points="2 12 12 17 22 12"/>
          </svg>
          <span id="sat-btn-text">{isSatellite ? 'Pamatkarte' : 'Aerofoto'}</span>
        </div>
      </div>

      <div id="zoom-ctl" role="group" aria-label="Kartes mērogs">
        <button type="button" id="zoom-in" title="Pietuvināt" onClick={() => map.current?.zoomIn()}>+</button>
        <button type="button" id="zoom-out" title="Attālināt" onClick={() => map.current?.zoomOut()}>−</button>
        <button type="button" id="loc-btn" title="Rādīt, kur es atrodos" onClick={handleLocate}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1a1209" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3.4"/>
            <circle cx="12" cy="12" r="7.6"/>
            <path d="M12 1.6v3M12 19.4v3M1.6 12h3M19.4 12h3"/>
          </svg>
        </button>
      </div>

      {/* Sānjoslas / Mobilā paneļa info panelis */}
      {selectedParcel && (
        <div className="panel">
          <div className="sheet-handle-bar">
            <div className="sheet-handle" />
          </div>
          <div className="panel-header">
            <div>
              <div style={{ fontSize: '11px', textTransform: 'uppercase', opacity: 0.85, letterSpacing: '0.05em' }}>
                Zemes vienība
              </div>
              <div className="panel-title">{selectedParcel.address || 'Nav piesaistītas adreses'}</div>
            </div>
            <button className="close-btn" onClick={() => setSelectedParcel(null)}>
              ✕
            </button>
          </div>

          <div className="panel-content">
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Kadastra numurs</div>
                <div className="kpi-value mono" style={{ fontSize: '13px' }}>
                  {selectedParcel.code}
                </div>
              </div>

              <div className="kpi-card">
                <div className="kpi-label">Zemes platība</div>
                <div className="kpi-value">
                  {selectedParcel.area_m2 ? `${selectedParcel.area_m2.toLocaleString('lv-LV')} m²` : '—'}
                </div>
              </div>

              <div className="kpi-card">
                <div className="kpi-label">Kadastrālā vērtība</div>
                <div className="kpi-value">
                  {selectedParcel.cadastral_value
                    ? `${selectedParcel.cadastral_value.toLocaleString('lv-LV')} €`
                    : 'Nav datu'}
                </div>
              </div>

              <div className="kpi-card">
                <div className="kpi-label">Statuss</div>
                <div className="kpi-value" style={{ fontSize: '13px', textTransform: 'capitalize' }}>
                  {selectedParcel.status || 'Aktīvs'}
                </div>
              </div>
            </div>

            {/* Energoefektivitātes sadaļa */}
            <div className="section-card">
              <div className="section-title">⚡ Ēkas energoefektivitāte (BVKB)</div>
              {selectedParcel.energy_cert ? (
                <div>
                  <div className="energy-card-row">
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '14px' }}>
                        {selectedParcel.energy_cert.class} klase
                      </div>
                      <div style={{ fontSize: '12px', color: '#64748b' }}>
                        {selectedParcel.energy_cert.heating_kwh_m2
                          ? `${Math.round(selectedParcel.energy_cert.heating_kwh_m2)} kWh/m² gadā (apkure)`
                          : 'Aprēķinātais patēriņš nav norādīts'}
                      </div>
                    </div>
                    <span
                      className={`energy-badge-pill energy-${selectedParcel.energy_cert.class.replace('+', '-plus')}`}
                    >
                      {selectedParcel.energy_cert.class}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '8px' }}>
                    Statuss: {selectedParcel.energy_cert.status || 'Reģistrēts'}
                    {selectedParcel.energy_cert.valid_until && ` · Derīgs līdz ${selectedParcel.energy_cert.valid_until}`}
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: '13px', color: '#6b7280', padding: '4px 0' }}>
                  Šim īpašumam BVKB reģistrā publisks energosertifikāts nav atrasts.
                </div>
              )}
            </div>

            {/* Vides riski & Piesārņojums */}
            <div className="section-card">
              <div className="section-title">⚠️ Vides riski un piesārņojums (VVD)</div>
              {selectedParcel.pollution_nearby && selectedParcel.pollution_nearby.length > 0 ? (
                <div>
                  <div style={{ fontSize: '12px', color: '#b91c1c', fontWeight: 600, marginBottom: '6px' }}>
                    Tuvumā konstatēti piesārņojuma riska objekti (≤ 500 m):
                  </div>
                  {selectedParcel.pollution_nearby.map((p, idx) => (
                    <div
                      key={idx}
                      className={`risk-alert-item ${p.category === 'Piesārņota vieta' ? 'bad' : 'warn'}`}
                    >
                      <div style={{ fontWeight: 700, display: 'flex', justifyContent: 'space-between' }}>
                        <span>{p.name}</span>
                        <span>{Math.round(p.distance_m)} m</span>
                      </div>
                      <div style={{ fontSize: '11px', opacity: 0.9 }}>
                        {p.category} · {p.site_type}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="risk-alert-item ok">
                  ✓ 500 m rādiusā oficiāli reģistrētu piesārņoto vietu nav konstatēts.
                </div>
              )}
            </div>

            {/* Darījumu sadaļa */}
            <div className="section-card">
              <div className="section-title">
                💶 VZD Darījumu vēsture ({transactions.length})
              </div>
              {transactions.length === 0 ? (
                <div style={{ fontSize: '13px', color: '#6b7280', padding: '6px 0' }}>
                  Šim kadastra numuram publisku darījumu nav reģistrēts.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {transactions.map((t) => (
                    <div
                      key={t.deal_id}
                      style={{
                        padding: '10px 12px',
                        background: '#fcfaf6',
                        borderRadius: '8px',
                        border: '1px solid #eee5d3',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 700, fontSize: '15px' }}>
                          {t.amount_eur.toLocaleString('lv-LV')} €
                        </span>
                        {t.price_per_m2 > 0 && (
                          <span style={{ color: '#0277bd', fontWeight: 600, fontSize: '12px' }}>
                            {Math.round(t.price_per_m2).toLocaleString('lv-LV')} €/m²
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px' }}>
                        Datums: {new Date(t.deal_date).toLocaleDateString('lv-LV')} · {t.property_type.toUpperCase()}
                        {t.area_m2 > 0 && ` · ${t.area_m2.toLocaleString('lv-LV')} m²`}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
