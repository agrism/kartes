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

  // Slāņu redzamība (kadastrakarte.lv pēc noklusējuma: 4 no 38 aktīvi)
  const [showParcels, setShowParcels] = useState(true);
  const [showBuildings, setShowBuildings] = useState(true);
  const [showTransactions, setShowTransactions] = useState(true);
  const [showListings, setShowListings] = useState(true);
  const [showFloods, setShowFloods] = useState(false);
  const [showEnergy, setShowEnergy] = useState(false);
  const [showPollution, setShowPollution] = useState(false);
  const [isSatellite, setIsSatellite] = useState(false);

  // Slāņu panelis (atvērts/aizvērts) - pēc noklusējuma sakļauts kā kadastrakarte.lv
  const [isLayersOpen, setIsLayersOpen] = useState(false);
  const showTransactionsRef = useRef(showTransactions);
  showTransactionsRef.current = showTransactions;
  const showListingsRef = useRef(showListings);
  showListingsRef.current = showListings;
  const updateMixMarkersRef = useRef<() => void>(() => {});

  const activeLayersCount =
    (showParcels ? 1 : 0) +
    (showBuildings ? 1 : 0) +
    (showTransactions ? 1 : 0) +
    (showListings ? 1 : 0) +
    (showEnergy ? 1 : 0) +
    (showPollution ? 1 : 0) +
    (showFloods ? 1 : 0) +
    (isSatellite ? 1 : 0);

  const clearAllLayers = () => {
    setShowParcels(false);
    setShowBuildings(false);
    setShowTransactions(false);
    setShowListings(false);
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

  const [currentZoom, setCurrentZoom] = useState(
    typeof window !== 'undefined' && window.location.hash.length > 3
      ? parseFloat(window.location.hash.slice(1).split('/')[0]) || 7.2
      : 7.2
  );

  // Inicializē MapLibre karti
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    const hasHash = typeof window !== 'undefined' && window.location.hash.length > 3;

    const m = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: hasHash ? [24.1048, 56.9495] : [24.6, 56.85], // Latvijas pārskats pēc noklusējuma
      zoom: hasHash ? 16 : 7.2,
      attributionControl: false,
      hash: true,
    });

    const updateZoom = () => setCurrentZoom(m.getZoom());
    m.on('zoom', updateZoom);
    m.on('moveend', updateZoom);

    // Seko līdzi klasteru HTML marķieriem
    const mixMkMap: { [id: string]: maplibregl.Marker } = {};
    let mixShownMap: { [id: string]: maplibregl.Marker } = {};

    const updateMixMarkers = () => {
      if (!m || !m.getSource('mix-pts')) return;
      const zoom = m.getZoom();
      const next: { [id: string]: maplibregl.Marker } = {};

      const showL = showListingsRef.current;
      const showT = showTransactionsRef.current;

      if (zoom < 14 && (showL || showT)) {
        try {
          const features = m.querySourceFeatures('mix-pts');
          for (const f of features) {
            if (!f.properties?.cluster) continue;
            const id = String(f.properties.cluster_id);
            if (next[id]) continue;

            let marker = mixMkMap[id];
            if (!marker) {
              const l = showL ? (Number(f.properties.l) || 0) : 0;
              const t = showT ? (Number(f.properties.t) || 0) : 0;
              const n = l + t;
              if (n === 0) continue;

              const fmt = (v: number) => v.toLocaleString('lv-LV').replace(/\s/g, ' ');
              const R = Math.round(Math.min(38, Math.max(25, 21 + Math.log10(Math.max(1, n)) * 3.5)));
              const deg = n > 0 ? (360 * l / n).toFixed(1) : '0';

              const el = document.createElement('div');
              el.className = 'mix-mk' + (R >= 33 ? ' lg' : '');
              el.style.width = `${2 * R}px`;
              el.style.height = `${2 * R}px`;
              el.style.background = `conic-gradient(#2f8a55 0 ${deg}deg, #7b1fa2 ${deg}deg 360deg)`;
              el.title = `${fmt(l)} sludinājumi · ${fmt(t)} objekti ar darījumu`;

              const inner = document.createElement('div');
              if (l > 0) {
                const s1 = document.createElement('span');
                s1.className = 'mix-l';
                s1.textContent = fmt(l);
                inner.appendChild(s1);
              }
              if (t > 0) {
                const s2 = document.createElement('span');
                s2.className = 'mix-t';
                s2.textContent = fmt(t);
                inner.appendChild(s2);
              }
              el.appendChild(inner);

              el.addEventListener('click', (e) => {
                e.stopPropagation();
                const src = m.getSource('mix-pts') as maplibregl.GeoJSONSource;
                src.getClusterExpansionZoom(Number(id)).then((targetZoom) => {
                  const coords = (f.geometry as GeoJSON.Point).coordinates;
                  m.easeTo({
                    center: [coords[0], coords[1]],
                    zoom: Math.min(Math.max(targetZoom, m.getZoom() + 1), 14.5),
                    duration: 600,
                  });
                }).catch(() => {});
              });

              const coords = (f.geometry as GeoJSON.Point).coordinates;
              marker = new maplibregl.Marker({ element: el }).setLngLat([coords[0], coords[1]]);
              mixMkMap[id] = marker;
            }

            next[id] = marker;
            if (!mixShownMap[id]) {
              marker.addTo(m);
            }
          }
        } catch (e) {
          // Source not ready yet
        }
      }

      for (const id in mixShownMap) {
        if (!next[id]) {
          mixShownMap[id].remove();
        }
      }
      mixShownMap = next;
    };

    updateMixMarkersRef.current = () => {
      for (const id in mixShownMap) {
        mixShownMap[id].remove();
      }
      for (const id in mixMkMap) {
        delete mixMkMap[id];
      }
      mixShownMap = {};
      updateMixMarkers();
    };

    m.on('load', () => {
      updateZoom();
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

      // 0.1 KOPĪGIE KLASTERI (z < 14, identiski kā kadastrakarte.lv)
      m.addSource('mix-pts', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterRadius: 105,
        clusterMaxZoom: 13,
        clusterProperties: {
          l: ['+', ['get', 'l']],
          t: ['+', ['get', 't']],
        },
      });

      m.addLayer({
        id: 'mix-one',
        type: 'circle',
        source: 'mix-pts',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': ['coalesce', ['get', 'color'], ['case', ['==', ['get', 'l'], 1], '#2f8a55', '#7b1fa2']],
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            8, 2.5,
            12, 3.8,
            14, 5.0,
            16, 6.5,
            18, 8.0,
          ],
          'circle-stroke-color': '#fff',
          'circle-stroke-width': [
            'interpolate', ['linear'], ['zoom'],
            8, 1.0,
            14, 1.6,
            18, 2.0,
          ],
          'circle-opacity': 0.95,
        },
      });

      m.on('mouseenter', 'mix-one', () => {
        m.getCanvas().style.cursor = 'pointer';
      });
      m.on('mouseleave', 'mix-one', () => {
        m.getCanvas().style.cursor = '';
      });
      m.on('click', 'mix-one', (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const coords = (feature.geometry as GeoJSON.Point).coordinates;
        const isL = feature.properties?.l === 1;
        const col = feature.properties?.color || (isL ? '#2f8a55' : '#7b1fa2');
        const title = isL
          ? 'Nekustamā īpašuma sludinājums'
          : (feature.properties?.color === '#0277bd' ? 'Zemes darījums' : (feature.properties?.color === '#e65100' ? 'Būves / mājas darījums' : 'Dzīvokļa darījums'));

        new maplibregl.Popup({ offset: 12 })
          .setLngLat([coords[0], coords[1]])
          .setHTML(`
            <div style="font-family: 'Hanken Grotesk', -apple-system, sans-serif; font-size: 13px; padding: 2px;">
              <div style="display:flex; align-items:center; gap:6px; font-weight:700; color:${col}; margin-bottom:4px;">
                <span style="width:10px; height:10px; border-radius:50%; background:${col}; display:inline-block; flex-shrink:0;"></span>
                ${title}
              </div>
              <div style="color:#666; font-size:11px;">Pietuviniet zemes vienībai, lai apskatītu pilnu kadastra un cenu vēsturi.</div>
            </div>
          `)
          .addTo(m);
      });

      m.on('render', updateMixMarkers);
      m.on('moveend', updateMixMarkers);
      m.on('idle', updateMixMarkers);
      m.on('data', (e: any) => {
        if (e.sourceId === 'mix-pts' && e.isSourceLoaded) {
          updateMixMarkers();
        }
      });

      // Ielādējam punktus (darījumus un sludinājumus)
      Promise.all([
        fetch('/data/listings-pts.json').then((r) => r.json()).catch(() => []),
        fetch('/data/tx-pts.json').then((r) => r.json()).catch(() => []),
      ]).then(([listingsData, txData]) => {
        const feats: any[] = [];
        if (Array.isArray(listingsData)) {
          for (const item of listingsData) {
            feats.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [item[0], item[1]] },
              properties: {
                l: 1,
                t: 0,
                color: '#2f8a55',
                portal: item[2],
                type: item[3],
              },
            });
          }
        }
        if (Array.isArray(txData) && txData.length >= 3) {
          const n = Math.floor(txData.length / 3);
          let x = 0;
          let y = 0;
          for (let i = 0; i < n; i++) {
            x += txData[3 * i];
            y += txData[3 * i + 1];
            const code = txData[3 * i + 2];
            const typeIdx = code >> 1; // 0=tg, 1=zv, 2=zvb
            // 0: telpu grupa (dzīvoklis) -> #7b1fa2
            // 1: zemes vienība (lauki / zeme) -> #0277bd (zili)
            // 2: zemes vienība ar būvi (māja) -> #e65100 (oranži)
            const color = typeIdx === 1 ? '#0277bd' : (typeIdx === 2 ? '#e65100' : '#7b1fa2');
            feats.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [x / 1e4, y / 1e4] },
              properties: {
                l: 0,
                t: 1,
                c: code,
                color: color,
              },
            });
          }
        }

        const src = m.getSource('mix-pts') as maplibregl.GeoJSONSource | undefined;
        if (src) {
          src.setData({
            type: 'FeatureCollection',
            features: feats,
          });
          setTimeout(updateMixMarkers, 50);
          setTimeout(updateMixMarkers, 300);
          setTimeout(updateMixMarkers, 800);
        }
      }).catch((e) => console.error('Error loading points:', e));

      // 1. ZEMES VIENĪBAS (Parcels) - detalizētās robežas no z12.5 (kā kadastrakarte.lv)
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
        minzoom: 12.5,
        paint: {
          'fill-color': '#1b6b3a',
          'fill-opacity': [
            'interpolate', ['linear'], ['zoom'],
            12.5, 0.05,
            15, 0.12,
          ],
        },
      });

      m.addLayer({
        id: 'parcels-line',
        type: 'line',
        source: 'parcels',
        'source-layer': 'parcels',
        minzoom: 12.5,
        paint: {
          'line-color': '#1b6b3a',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            12.5, 0.5,
            14, 1.2,
            17, 2.0,
          ],
          'line-opacity': [
            'interpolate', ['linear'], ['zoom'],
            12.5, 0.65,
            15, 0.85,
          ],
        },
      });

      // 2. ĒKAS (Buildings) - detalizētie ēku korpusi no z13 (kā kadastrakarte.lv)
      m.addSource('buildings', {
        type: 'vector',
        tiles: [`${TILES_BASE}/buildings/{z}/{x}/{y}`],
        minzoom: 13,
        maxzoom: 22,
      });

      m.addLayer({
        id: 'buildings-fill',
        type: 'fill',
        source: 'buildings',
        'source-layer': 'buildings',
        minzoom: 13,
        paint: {
          'fill-color': '#475569',
          'fill-opacity': [
            'interpolate', ['linear'], ['zoom'],
            13, 0.4,
            15, 0.7,
          ],
        },
      });

      m.addLayer({
        id: 'buildings-line',
        type: 'line',
        source: 'buildings',
        'source-layer': 'buildings',
        minzoom: 13,
        paint: {
          'line-color': '#1e293b',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            13, 0.6,
            16, 1.2,
          ],
          'line-opacity': 0.9,
        },
      });

      // 3. DARĪJUMI (Transactions) - detalizētie punkti no z14 (kā kadastrakarte.lv)
      m.addSource('transactions', {
        type: 'vector',
        tiles: [`${TILES_BASE}/transactions/{z}/{x}/{y}`],
        minzoom: 13,
        maxzoom: 22,
      });

      m.addLayer({
        id: 'transactions-circle',
        type: 'circle',
        source: 'transactions',
        'source-layer': 'transactions',
        minzoom: 14,
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            14, 4.5,
            16, 7.5,
            18, 9.0,
          ],
          'circle-color': [
            'interpolate', ['linear'], ['to-number', ['get', 'price_per_m2'], 500],
            50, '#10b981',    // Zema cena / lauki
            500, '#0284c7',   // Vidēja cena
            1500, '#f59e0b',  // Premium
            3000, '#ef4444',  // Ekskluzīvs
          ],
          'circle-stroke-width': 1.8,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.85,
        },
      });

      // 4. BVKB ĒKU ENERGOSERTIFIKĀTI
      m.addSource('energy', {
        type: 'vector',
        tiles: [`${TILES_BASE}/energy_certificates/{z}/{x}/{y}`],
        minzoom: 6,
        maxzoom: 22,
      });

      m.addLayer({
        id: 'energy-dots',
        type: 'circle',
        source: 'energy',
        'source-layer': 'energy_certificates',
        minzoom: 6,
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            6, 1.0,
            8, 2.0,
            10, 3.2,
            13, 5.0,
            17, 8.5,
          ],
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
          'circle-stroke-width': [
            'interpolate', ['linear'], ['zoom'],
            6, 0,
            10, 0.5,
            13, 1.2,
            16, 1.8,
          ],
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9,
        },
      });

      // 5. VVD PIESĀRŅOTĀS VIETAS
      m.addSource('pollution', {
        type: 'vector',
        tiles: [`${TILES_BASE}/pollution_sites/{z}/{x}/{y}`],
        minzoom: 5,
        maxzoom: 22,
      });

      m.addLayer({
        id: 'pollution-dots',
        type: 'circle',
        source: 'pollution',
        'source-layer': 'pollution_sites',
        minzoom: 5,
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            5, 2.0,
            8, 3.8,
            11, 5.5,
            14, 7.5,
            18, 10.0,
          ],
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
    if (map.current.getLayer('mix-one')) {
      const showL = showListings;
      const showT = showTransactions;
      if (!showL && !showT) {
        map.current.setLayoutProperty('mix-one', 'visibility', 'none');
      } else {
        map.current.setLayoutProperty('mix-one', 'visibility', 'visible');
        if (showL && showT) {
          map.current.setFilter('mix-one', ['!', ['has', 'point_count']]);
        } else if (showL) {
          map.current.setFilter('mix-one', ['all', ['!', ['has', 'point_count']], ['==', ['get', 'l'], 1]]);
        } else if (showT) {
          map.current.setFilter('mix-one', ['all', ['!', ['has', 'point_count']], ['==', ['get', 't'], 1]]);
        }
      }
    }
    updateMixMarkersRef.current();
  }, [showParcels, showBuildings, showTransactions, showListings, showFloods, showEnergy, showPollution, isSatellite]);

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
      {/* 1. TOP NAVBAR (Identisks ar kadastrakarte.lv) */}
      <header id="navbar">
        <div className="nav-inner">
          <a href="/" className="nav-logo">
            <div className="nav-logo-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                <polyline points="9 22 9 12 15 12 15 22"/>
              </svg>
            </div>
            <span className="nav-logo-text">Kadastra Karte</span>
          </a>

          <nav className="nav-links">
            <a href="#sakums">Sākums</a>
            <a href="/" className="active">Karte</a>
            <a href="#meklet">Meklēt</a>
            <a href="#cik-maksa" style={{ position: 'relative' }}>
              <span className="nav-badge-jaunums">JAUNUMS</span>
              Cik maksā
            </a>
            <a href="#pazinojumi">Paziņojumi</a>
            <a href="#kontakti">Kontakti</a>
          </nav>

          <div className="nav-actions">
            <button type="button" className="nav-login-btn">
              Ielogoties
            </button>
            <div className="nav-lang">
              <button type="button" className="nav-lang-btn active">LV</button>
              <button type="button" className="nav-lang-btn">EN</button>
              <button type="button" className="nav-lang-btn">RU</button>
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
              <div className="lc-badge-active">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
              </div>
              <div id="lc-info">
                <div id="lc-title">{activeLayersCount} no 38 slāņiem aktīvi</div>
                <div id="lc-sub" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: '#1b6b3a' }} />
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: '#2f8a55' }} />
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: '#0284c7' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
                    ss.com sludinājumi, pp....
                  </span>
                </div>
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
                      {currentZoom < 12.5 && <span className="lc-row-hint">pietuviniet</span>}
                      <button className={`lc-tog ${showParcels ? 'on' : ''}`} type="button" tabIndex={-1}>
                        <div className="lc-tog-k" />
                      </button>
                    </div>
                    <div className={`lc-row ${showBuildings ? 'on' : ''}`} onClick={() => setShowBuildings(!showBuildings)}>
                      <div className="lc-swatch" style={{ background: '#334155' }} />
                      <span className="lc-row-name">Ēkas un būves</span>
                      {currentZoom < 13 && <span className="lc-row-hint">pietuviniet</span>}
                      <button className={`lc-tog ${showBuildings ? 'on' : ''}`} type="button" tabIndex={-1}>
                        <div className="lc-tog-k" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* 2. SLUDINĀJUMI UN DARĪJUMI */}
                <div className="lc-cat open" style={{ marginTop: 8 }}>
                  <div className="lc-cat-hdr">
                    <div className="lc-tile" style={{ background: '#eaf4ee', color: '#2f8a55' }}>🏷️</div>
                    <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>Sludinājumi un darījumi</span>
                  </div>
                  <div className="lc-layers">
                    <div className={`lc-row ${showListings ? 'on' : ''}`} onClick={() => setShowListings(!showListings)}>
                      <div className="lc-swatch" style={{ background: '#2f8a55' }} />
                      <span className="lc-row-name">ss.com sludinājumi</span>
                      <button className={`lc-tog ${showListings ? 'on' : ''}`} type="button" tabIndex={-1}>
                        <div className="lc-tog-k" />
                      </button>
                    </div>
                    <div className={`lc-row ${showTransactions ? 'on' : ''}`} onClick={() => setShowTransactions(!showTransactions)}>
                      <div className="lc-swatch" style={{ background: '#7b1fa2' }} />
                      <span className="lc-row-name">VZD darījumu vēsture</span>
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
