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

  // Inicializē MapLibre karti
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    const m = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: [24.1048, 56.9495], // Vecrīga / Centrs
      zoom: 16,
    });

    const geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    });
    m.addControl(geolocate, 'bottom-right');
    m.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');

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
      <div id="map" ref={mapContainer} />

      {/* Galvenā augšējā josla ar meklēšanu un slāņu kontroli */}
      <div className="top-bar">
        <div className="search-container">
          <span className="search-icon">🔍</span>
          <input
            ref={searchInputRef}
            type="text"
            className="search-input"
            placeholder="Meklēt adresi (piem. Brīvības 38, Doma laukums)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => {
                setSearchQuery('');
                setSuggestions([]);
              }}
              aria-label="Notīrīt meklēšanu"
            >
              ✕
            </button>
          )}

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

        {/* Slāņu ieslēgšanas/izslēgšanas poga ar horizontālu ritināšanu telefonā */}
        <div className="layer-pills-container">
          <div className="layer-pills">
            <button
              className={`layer-pill ${isSatellite ? 'active-dark' : ''}`}
              onClick={() => setIsSatellite(!isSatellite)}
            >
              {isSatellite ? '🗺️ Karte' : '🛰️ Satelīts'}
            </button>
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
            <button
              className={`layer-pill ${showEnergy ? 'active-amber' : ''}`}
              onClick={() => setShowEnergy(!showEnergy)}
              title="BVKB ēku energoefektivitātes klases (A+ līdz G)"
            >
              ⚡ Enerģija
            </button>
            <button
              className={`layer-pill ${showPollution ? 'active-red' : ''}`}
              onClick={() => setShowPollution(!showPollution)}
              title="VVD reģistrētās piesārņotās un potenciāli piesārņotās vietas"
            >
              ⚠️ Piesārņojums
            </button>
          </div>
        </div>

        {/* Statistika */}
        <div className="stat-badge">
          <span>🇱🇻 VZD + BVKB + VVD</span>
        </div>
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
