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
}

const API_BASE = (import.meta as any).env.VITE_API_URL || 'http://localhost:8090';
const TILES_BASE = (import.meta as any).env.VITE_TILES_URL || 'http://localhost:3000';

export default function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedParcel, setSelectedParcel] = useState<ParcelInfo | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);

  // Inicializē MapLibre karti
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    const m = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: [24.1048, 56.9495], // Vecrīga / Doma laukums
      zoom: 16.5,
    });

    m.addControl(new maplibregl.NavigationControl(), 'bottom-right');

    m.on('load', () => {
      // 1. Pievieno Martin MVT vektoru flīžu avotu
      m.addSource('parcels', {
        type: 'vector',
        tiles: [`${TILES_BASE}/parcels/{z}/{x}/{y}`],
        minzoom: 12,
        maxzoom: 22,
      });

      // 2. Zemes vienību laukuma aizpildījums
      m.addLayer({
        id: 'parcels-fill',
        type: 'fill',
        source: 'parcels',
        'source-layer': 'parcels',
        paint: {
          'fill-color': '#1b6b3a',
          'fill-opacity': 0.15,
        },
      });

      // 3. Zemes vienību robežlīnijas
      m.addLayer({
        id: 'parcels-line',
        type: 'line',
        source: 'parcels',
        'source-layer': 'parcels',
        paint: {
          'line-color': '#1b6b3a',
          'line-width': 2,
        },
      });

      // Kursors un klikšķa notikums uz zemes vienības
      m.on('mouseenter', 'parcels-fill', () => {
        m.getCanvas().style.cursor = 'pointer';
      });

      m.on('mouseleave', 'parcels-fill', () => {
        m.getCanvas().style.cursor = '';
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

  // Iegūst zemes vienības datus un darījumus no Go API
  const fetchParcelDetails = async (code: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/parcel-info?code=${encodeURIComponent(code)}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedParcel(data);
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
    }, 200);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleSelectSuggestion = (s: Suggestion) => {
    setSearchQuery(s.address);
    setSuggestions([]);
    fetchParcelDetails(s.code);
  };

  return (
    <>
      <div id="map" ref={mapContainer} />

      {/* Meklēšanas josla */}
      <div className="top-bar">
        <div className="search-container">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            className="search-input"
            placeholder="Meklēt adresi vai kadastra numuru..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          {suggestions.length > 0 && (
            <div className="suggestions-dropdown">
              {suggestions.map((s) => (
                <div
                  key={s.code}
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
      </div>

      {/* Sānjoslas info panelis */}
      {selectedParcel && (
        <div className="panel">
          <div className="panel-header">
            <div>
              <div style={{ fontSize: '11px', textTransform: 'uppercase', opacity: 0.85 }}>
                Zemes vienība
              </div>
              <div className="panel-title">{selectedParcel.address || 'Nav adreses'}</div>
            </div>
            <button className="close-btn" onClick={() => setSelectedParcel(null)}>
              ✕
            </button>
          </div>

          <div className="panel-content">
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Kadastra numurs</div>
                <div className="kpi-value mono" style={{ fontSize: '14px' }}>
                  {selectedParcel.code}
                </div>
              </div>

              <div className="kpi-card">
                <div className="kpi-label">Zemes platība</div>
                <div className="kpi-value">
                  {selectedParcel.area_m2.toLocaleString('lv-LV')} m²
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
                <div className="kpi-value" style={{ fontSize: '14px', textTransform: 'capitalize' }}>
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
                <div style={{ fontSize: '13px', color: '#6b7280' }}>
                  Šim īpašumam reģistrētu darījumu nav.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {transactions.map((t) => (
                    <div
                      key={t.deal_id}
                      style={{
                        padding: '10px',
                        background: '#fcfaf6',
                        borderRadius: '8px',
                        border: '1px solid #eee5d3',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                        <span>{t.amount_eur.toLocaleString('lv-LV')} €</span>
                        <span style={{ color: '#0277bd', fontSize: '12px' }}>
                          {t.price_per_m2 ? `${t.price_per_m2.toLocaleString('lv-LV')} €/m²` : ''}
                        </span>
                      </div>
                      <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px' }}>
                        Datums: {new Date(t.deal_date).toLocaleDateString('lv-LV')} · Tips: {t.property_type.toUpperCase()}
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
