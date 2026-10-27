import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';

interface ParcelInfo {
  code: string;
  address: string;
  area_m2: number;
  status: string;
  cadastral_value: number;
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

const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const API_BASE = (import.meta as any).env.VITE_API_URL ?? (isLocal ? 'http://localhost:8090' : '');
const TILES_BASE = (import.meta as any).env.VITE_TILES_URL ?? (isLocal ? 'http://localhost:3000' : '/tiles');

export default function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedParcel, setSelectedParcel] = useState<ParcelInfo | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);

  // Slāņu redzamība
  const [showParcels, setShowParcels] = useState(true);
  const [showBuildings, setShowBuildings] = useState(true);
  const [showTransactions, setShowTransactions] = useState(true);

  // Inicializē MapLibre karti
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    const m = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: [24.1048, 56.9495], // Vecrīga / Centrs
      zoom: 16,
    });

    m.addControl(new maplibregl.NavigationControl(), 'bottom-right');

    m.on('load', () => {
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
            'interpolate', ['linear'], ['coalesce', ['get', 'price_per_m2'], 500],
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

      // Interaktivitāte kursoram
      const interactiveLayers = ['parcels-fill', 'buildings-fill', 'transactions-circle'];
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
  }, [showParcels, showBuildings, showTransactions]);

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
      <div id="map" ref={mapContainer} />

      {/* Galvenā augšējā josla ar meklēšanu un slāņu kontroli */}
      <div className="top-bar">
        <div className="search-container">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            className="search-input"
            placeholder="Meklēt adresi (piem. Brīvības 38, Doma laukums)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          {suggestions.length > 0 && (
            <div className="suggestions-dropdown">
              {suggestions.map((s, idx) => (
                <div
                  key={`${s.code}-${idx}`}
                  className="suggestion-item"
                  onClick={() => handleSelectSuggestion(s)}
                >
                  <span className="suggestion-title">{s.address}</span>
                  <span className="suggestion-code">{s.code}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Slāņu ieslēgšanas/izslēgšanas poga */}
        <div className="layer-pills">
          <button
            className={`layer-pill ${showParcels ? 'active-green' : ''}`}
            onClick={() => setShowParcels(!showParcels)}
          >
            🗺️ Zemes gabali
          </button>
          <button
            className={`layer-pill ${showBuildings ? 'active-slate' : ''}`}
            onClick={() => setShowBuildings(!showBuildings)}
          >
            🏢 Ēkas
          </button>
          <button
            className={`layer-pill ${showTransactions ? 'active-blue' : ''}`}
            onClick={() => setShowTransactions(!showTransactions)}
          >
            💶 Darījumi
          </button>
        </div>

        {/* Statistika */}
        <div className="stat-badge">
          <span>🇱🇻 VZD Atvērtie dati</span>
        </div>
      </div>

      {/* Sānjoslas info panelis */}
      {selectedParcel && (
        <div className="panel">
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

            {/* Darījumu sadaļa */}
            <div className="section-card">
              <div className="section-title">
                VZD Darījumu vēsture ({transactions.length})
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
