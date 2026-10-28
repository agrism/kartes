import React, { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';

const LISTING_CATS = [
  { key: 'flats', name: 'Dzīvokļi' },
  { key: 'houses', name: 'Mājas' },
  { key: 'land', name: 'Zeme' },
  { key: 'commercial', name: 'Komerc' },
  { key: 'forest', name: 'Mežs' },
  { key: 'farms', name: 'Lauku īp.' },
  { key: 'garage', name: 'Garāža' },
];

const LF_ROOMS = [1, 2, 3, 4, 5, 6];
const LF_FLOORS = Array.from({ length: 16 }, (_, i) => i + 1);

const normalizeCategory = (cat: string): string => {
  if (!cat) return '';
  const c = String(cat).toLowerCase();
  if (c === 'flats' || c === 'apartment' || c === 'dzivokli') return 'flats';
  if (c === 'houses' || c === 'house' || c === 'homes-summer-residences' || c === 'majas') return 'houses';
  if (c === 'land' || c === 'plots-and-lands' || c === 'zeme') return 'land';
  if (c === 'commercial' || c === 'premises' || c === 'offices' || c === 'komerc') return 'commercial';
  if (c === 'forest' || c === 'wood' || c === 'mezs') return 'forest';
  if (c === 'farms' || c === 'farms-estates' || c === 'lauku-ipasumi') return 'farms';
  if (c === 'garage' || c === 'garages' || c === 'garaza') return 'garage';
  return c;
};

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
    dataBase: origin,
  };
}

function formatShortPrice(price: number): string {
  if (!price || price <= 0) return '';
  if (price >= 1_000_000) {
    const m = price / 1_000_000;
    return (m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)) + 'M';
  }
  if (price >= 10_000) {
    return Math.round(price / 1000) + 'K';
  }
  if (price >= 1_000) {
    const k = price / 1000;
    return (k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)) + 'K';
  }
  return `${Math.round(price)} €`;
}

function createRoundBadge(color: string) {
  const S = 2, W = 64, pH = 22, arH = 6, H = pH + arH, R = 5;
  const c = document.createElement('canvas');
  c.width = W * S;
  c.height = H * S;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.scale(S, S);
  const cx = W / 2, aw = 5;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(R, 0);
  ctx.lineTo(W - R, 0);
  ctx.arcTo(W, 0, W, R, R);
  ctx.lineTo(W, pH - R);
  ctx.arcTo(W, pH, W - R, pH, R);
  ctx.lineTo(cx + aw, pH);
  ctx.lineTo(cx, pH + arH);
  ctx.lineTo(cx - aw, pH);
  ctx.lineTo(R, pH);
  ctx.arcTo(0, pH, 0, pH - R, R);
  ctx.lineTo(0, R);
  ctx.arcTo(0, 0, R, 0, R);
  ctx.closePath();
  ctx.fill();
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return {
    width: c.width,
    height: c.height,
    data: new Uint8Array(d.data.buffer),
    // Two-sided stretch so the arrow in the middle stays fixed in width and centered
    stretchX: [
      [R * S, (cx - aw) * S],
      [(cx + aw) * S, (W - R) * S],
    ] as [number, number][],
    stretchY: [[R * S, (pH - R) * S]] as [number, number][],
    content: [R * S, 2 * S, (W - R) * S, (pH - 2) * S] as [number, number, number, number],
  };
}

export default function App() {
  const { apiBase: API_BASE, tilesBase: TILES_BASE, dataBase: DATA_BASE } = getEndpoints();
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedParcel, setSelectedParcel] = useState<ParcelInfo | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);

  // Sludinājuma vēstures un popup stāvoklis
  const currentPopupRef = useRef<maplibregl.Popup | null>(null);
  const [historyModal, setHistoryModal] = useState<{
    open: boolean;
    item: any;
    history: any | null;
    loading: boolean;
  }>({ open: false, item: null, history: null, loading: false });

  const openHistoryModal = (item: any) => {
    setHistoryModal({ open: true, item, history: null, loading: true });
    const mid = item.mid || item.id || '';
    const portal = item.portal || 'ss.com';
    fetch(`${API_BASE}/api/listing-history?mid=${mid}&portal=${portal}`)
      .then((r) => r.json())
      .then((data) => {
        setHistoryModal((prev) => ({
          ...prev,
          history: data.ok ? data : null,
          loading: false,
        }));
      })
      .catch(() => {
        setHistoryModal((prev) => ({ ...prev, loading: false }));
      });
  };

  useEffect(() => {
    (window as any).__openListingHistory = (itemStr: string) => {
      try {
        const item = JSON.parse(decodeURIComponent(itemStr));
        openHistoryModal(item);
      } catch (err) {}
    };
    (window as any).__openParcelReport = (code: string) => {
      if (code) fetchParcelDetails(code);
    };
    (window as any).__closeCurrentPopup = () => {
      if (currentPopupRef.current) {
        currentPopupRef.current.remove();
      }
    };
  });

  // Slāņu redzamība
  const [showParcels, setShowParcels] = useState(true);
  const [showBuildings, setShowBuildings] = useState(true);
  const [showTransactions, setShowTransactions] = useState(true);
  const [showListingsSS, setShowListingsSS] = useState(true);
  const [showListingsC24, setShowListingsC24] = useState(true);
  const [showListingsPP, setShowListingsPP] = useState(true);
  const [showAuctions, setShowAuctions] = useState(true);
  const [showZoning, setShowZoning] = useState(false);
  const [showConstruction, setShowConstruction] = useState(false);
  const [showForests, setShowForests] = useState(false);
  const [showServituti, setShowServituti] = useState(false);
  const [showProtected, setShowProtected] = useState(false);
  const [showNature, setShowNature] = useState(false);
  const [showFloods, setShowFloods] = useState(false);
  const [showEnergy, setShowEnergy] = useState(false);
  const [showPollution, setShowPollution] = useState(false);
  const [showDegrading, setShowDegrading] = useState(false);
  const [showSchools, setShowSchools] = useState(false);
  const [showTransports, setShowTransports] = useState(false);
  const [isSatellite, setIsSatellite] = useState(false);

  // Slāņu panelis (atvērts/aizvērts) - pēc noklusējuma sakļauts kā kadastrakarte.lv
  const [isLayersOpen, setIsLayersOpen] = useState(false);
  const showTransactionsRef = useRef(showTransactions);
  showTransactionsRef.current = showTransactions;
  const showListingsSSRef = useRef(showListingsSS);
  showListingsSSRef.current = showListingsSS;
  const showListingsC24Ref = useRef(showListingsC24);
  showListingsC24Ref.current = showListingsC24;
  const showListingsPPRef = useRef(showListingsPP);
  showListingsPPRef.current = showListingsPP;
  const showAuctionsRef = useRef(showAuctions);
  showAuctionsRef.current = showAuctions;
  const updateMixMarkersRef = useRef<() => void>(() => {});
  const syncMixPointsRef = useRef<() => void>(() => {});

  // Sludinājumu filtri (kadastrakarte.lv dizains)
  const [listingDeal, setListingDeal] = useState<'all' | 'sell' | 'rent'>('all');
  const [listingCats, setListingCats] = useState<Set<string>>(new Set());
  const [isFiltersPanelOpen, setIsFiltersPanelOpen] = useState(false);
  const [filterPMin, setFilterPMin] = useState<string>('');
  const [filterPMax, setFilterPMax] = useState<string>('');
  const [filterAMin, setFilterAMin] = useState<string>('');
  const [filterAMax, setFilterAMax] = useState<string>('');
  const [filterRMin, setFilterRMin] = useState<string>('');
  const [filterRMax, setFilterRMax] = useState<string>('');
  const [filterFMin, setFilterFMin] = useState<string>('');
  const [filterFMax, setFilterFMax] = useState<string>('');
  const [filterNoFirst, setFilterNoFirst] = useState<boolean>(false);
  const [visibleListingsCount, setVisibleListingsCount] = useState<number>(0);

  const rawListingsRef = useRef<any[]>([]);
  const rawAuctionsRef = useRef<any[]>([]);
  const rawTxRef = useRef<any[]>([]);
  const filteredListingsRef = useRef<any[]>([]);
  const filteredAuctionsRef = useRef<any[]>([]);

  const listingDealRef = useRef(listingDeal);
  listingDealRef.current = listingDeal;
  const listingCatsRef = useRef(listingCats);
  listingCatsRef.current = listingCats;
  const filterPMinRef = useRef(filterPMin);
  filterPMinRef.current = filterPMin;
  const filterPMaxRef = useRef(filterPMax);
  filterPMaxRef.current = filterPMax;
  const filterAMinRef = useRef(filterAMin);
  filterAMinRef.current = filterAMin;
  const filterAMaxRef = useRef(filterAMax);
  filterAMaxRef.current = filterAMax;
  const filterRMinRef = useRef(filterRMin);
  filterRMinRef.current = filterRMin;
  const filterRMaxRef = useRef(filterRMax);
  filterRMaxRef.current = filterRMax;
  const filterFMinRef = useRef(filterFMin);
  filterFMinRef.current = filterFMin;
  const filterFMaxRef = useRef(filterFMax);
  filterFMaxRef.current = filterFMax;
  const filterNoFirstRef = useRef(filterNoFirst);
  filterNoFirstRef.current = filterNoFirst;

  const applyListingFiltersRef = useRef<() => void>(() => {});
  const updateViewportCountRef = useRef<() => void>(() => {});

  const showFlatFields = listingCats.size === 0 || listingCats.has('flats');
  const showRoomsFields = listingCats.size === 0 || listingCats.has('flats') || listingCats.has('houses');

  const activeDetailedFiltersCount = useMemo(() => {
    let count = 0;
    if (filterPMin !== '') count++;
    if (filterPMax !== '') count++;
    if (filterAMin !== '') count++;
    if (filterAMax !== '') count++;
    if (filterRMin !== '') count++;
    if (filterRMax !== '') count++;
    if (filterFMin !== '') count++;
    if (filterFMax !== '') count++;
    if (filterNoFirst) count++;
    return count;
  }, [filterPMin, filterPMax, filterAMin, filterAMax, filterRMin, filterRMax, filterFMin, filterFMax, filterNoFirst]);

  const hasAnyFilter = useMemo(() => {
    return activeDetailedFiltersCount > 0 || listingCats.size > 0 || listingDeal !== 'all';
  }, [activeDetailedFiltersCount, listingCats.size, listingDeal]);

  const clearAllListingFilters = () => {
    setListingDeal('all');
    setListingCats(new Set());
    setFilterPMin('');
    setFilterPMax('');
    setFilterAMin('');
    setFilterAMax('');
    setFilterRMin('');
    setFilterRMax('');
    setFilterFMin('');
    setFilterFMax('');
    setFilterNoFirst(false);
  };

  const toggleListingCat = (key: string) => {
    setListingCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  useEffect(() => {
    applyListingFiltersRef.current();
  }, [
    listingDeal,
    listingCats,
    filterPMin,
    filterPMax,
    filterAMin,
    filterAMax,
    filterRMin,
    filterRMax,
    filterFMin,
    filterFMax,
    filterNoFirst,
    showListingsSS,
    showListingsC24,
    showListingsPP,
    showAuctions,
    showTransactions,
  ]);

  const sludinajumiActive =
    (showListingsSS ? 1 : 0) +
    (showListingsC24 ? 1 : 0) +
    (showListingsPP ? 1 : 0) +
    (showAuctions ? 1 : 0);

  const totalLayersCount = 20;
  const activeLayersCount =
    (showParcels ? 1 : 0) +
    (showBuildings ? 1 : 0) +
    (showTransactions ? 1 : 0) +
    sludinajumiActive +
    (showZoning ? 1 : 0) +
    (showConstruction ? 1 : 0) +
    (showForests ? 1 : 0) +
    (showServituti ? 1 : 0) +
    (showProtected ? 1 : 0) +
    (showNature ? 1 : 0) +
    (showFloods ? 1 : 0) +
    (showEnergy ? 1 : 0) +
    (showPollution ? 1 : 0) +
    (showDegrading ? 1 : 0) +
    (showSchools ? 1 : 0) +
    (showTransports ? 1 : 0) +
    (isSatellite ? 1 : 0);

  const kadastrsActive = (showParcels ? 1 : 0) + (showBuildings ? 1 : 0);
  const darijumiActive = showTransactions ? 1 : 0;
  const riskiActive = (showFloods ? 1 : 0) + (showPollution ? 1 : 0) + (showDegrading ? 1 : 0);
  const planojumsActive = (showZoning ? 1 : 0) + (showConstruction ? 1 : 0);
  const dabaActive = (showForests ? 1 : 0) + (showServituti ? 1 : 0) + (showProtected ? 1 : 0) + (showNature ? 1 : 0);
  const apkartneActive = (showSchools ? 1 : 0) + (showTransports ? 1 : 0);
  const ekaActive = (showEnergy ? 1 : 0) + (isSatellite ? 1 : 0);

  const [openCats, setOpenCats] = useState<Set<string>>(() => new Set(['sludinajumi', 'darijumi', 'kadastrs']));
  const toggleCat = (id: string) => {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const clearAllLayers = () => {
    setShowParcels(false);
    setShowBuildings(false);
    setShowTransactions(false);
    setShowListingsSS(false);
    setShowListingsC24(false);
    setShowListingsPP(false);
    setShowAuctions(false);
    setShowZoning(false);
    setShowConstruction(false);
    setShowForests(false);
    setShowServituti(false);
    setShowProtected(false);
    setShowNature(false);
    setShowFloods(false);
    setShowEnergy(false);
    setShowPollution(false);
    setShowDegrading(false);
    setShowSchools(false);
    setShowTransports(false);
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

      const showL = showListingsSSRef.current || showListingsC24Ref.current || showListingsPPRef.current || showAuctionsRef.current;
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

      // 0.1.1 Natīvais WebGL klastera aplis (ātrs, stabils, zīmējas pie jebkura zoom < 14)
      m.addLayer({
        id: 'mix-clusters',
        type: 'circle',
        source: 'mix-pts',
        maxzoom: 14,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': [
            'case',
            ['>', ['get', 't'], 0],
            '#6d28d9',
            '#2f8a55',
          ],
          'circle-opacity': 0.92,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-radius': [
            'interpolate', ['linear'], ['sqrt', ['get', 'point_count']],
            1, 14,
            10, 18,
            50, 24,
            200, 32,
            1000, 42,
          ],
        },
      });

      // 0.1.2 Klastera skaitlis (balts teksts centrā)
      m.addLayer({
        id: 'mix-cluster-labels',
        type: 'symbol',
        source: 'mix-pts',
        maxzoom: 14,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['to-string', ['get', 'point_count']],
          'text-font': ['Noto Sans Regular'],
          'text-size': [
            'interpolate', ['linear'], ['sqrt', ['get', 'point_count']],
            1, 11,
            50, 12.5,
            1000, 14,
          ],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#ffffff',
        },
      });

      m.addLayer({
        id: 'mix-one',
        type: 'circle',
        source: 'mix-pts',
        maxzoom: 14,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': ['case', ['==', ['get', 'l'], 1], '#2f8a55', '#7b1fa2'],
          'circle-radius': 4.5,
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 1.5,
        },
      });

      // Klastera klikšķis — pietuvina klasteri
      m.on('click', 'mix-clusters', (e) => {
        const features = m.queryRenderedFeatures(e.point, { layers: ['mix-clusters'] });
        const clusterId = features[0]?.properties?.cluster_id;
        if (clusterId != null) {
          const src = m.getSource('mix-pts') as maplibregl.GeoJSONSource;
          src.getClusterExpansionZoom(clusterId).then((zoom) => {
            const coords = (features[0].geometry as GeoJSON.Point).coordinates;
            m.easeTo({
              center: [coords[0], coords[1]],
              zoom: Math.min(zoom + 0.5, 14.5),
              duration: 600,
            });
          }).catch(() => {});
        }
      });
      m.on('mouseenter', 'mix-clusters', () => { m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', 'mix-clusters', () => { m.getCanvas().style.cursor = ''; });

      // 0.2 Cenu bērkas (zaļās sludinājumiem, dzintara izsolēm)
      const greenBadge = createRoundBadge('#2f8a55');
      if (greenBadge && !m.hasImage('badge-green')) {
        m.addImage(
          'badge-green',
          { width: greenBadge.width, height: greenBadge.height, data: greenBadge.data },
          { pixelRatio: 2, stretchX: greenBadge.stretchX, stretchY: greenBadge.stretchY, content: greenBadge.content }
        );
      }

      const amberBadge = createRoundBadge('#c8860a');
      if (amberBadge && !m.hasImage('badge-amber')) {
        m.addImage(
          'badge-amber',
          { width: amberBadge.width, height: amberBadge.height, data: amberBadge.data },
          { pixelRatio: 2, stretchX: amberBadge.stretchX, stretchY: amberBadge.stretchY, content: amberBadge.content }
        );
      }

      // Sludinājumu avots (apvieno visus portālus: ss.com, city24, pp.lv)
      m.addSource('listings-pts', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      // ── ss.com slāņi ──
      m.addLayer({
        id: 'listings-ss-dots',
        type: 'circle',
        source: 'listings-pts',
        minzoom: 13.5,
        filter: ['in', ['get', 'portal'], ['literal', ['ss.com', 'ss']]],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13.5, 4.5, 15, 6.0, 17, 8.0],
          'circle-color': '#2f8a55',
          'circle-stroke-width': 2.0,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.95,
        },
      });
      m.addLayer({
        id: 'listings-ss-badges',
        type: 'symbol',
        source: 'listings-pts',
        minzoom: 13.5,
        filter: ['all', ['in', ['get', 'portal'], ['literal', ['ss.com', 'ss']]], ['!=', ['get', 'price_short'], '']],
        layout: {
          'icon-image': 'badge-green',
          'icon-anchor': 'bottom',
          'icon-text-fit': 'both',
          'icon-text-fit-padding': [1, 6, 1, 6],
          'text-field': ['get', 'price_short'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'text-anchor': 'bottom',
          'text-offset': [0, -0.65],
          'icon-allow-overlap': false,
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#ffffff' },
      });

      // ── city24 slāņi ──
      m.addLayer({
        id: 'listings-c24-dots',
        type: 'circle',
        source: 'listings-pts',
        minzoom: 13.5,
        filter: ['in', ['get', 'portal'], ['literal', ['city24', 'city24.lv']]],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13.5, 4.5, 15, 6.0, 17, 8.0],
          'circle-color': '#2f8a55',
          'circle-stroke-width': 2.0,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.95,
        },
      });
      m.addLayer({
        id: 'listings-c24-badges',
        type: 'symbol',
        source: 'listings-pts',
        minzoom: 13.5,
        filter: ['all', ['in', ['get', 'portal'], ['literal', ['city24', 'city24.lv']]], ['!=', ['get', 'price_short'], '']],
        layout: {
          'icon-image': 'badge-green',
          'icon-anchor': 'bottom',
          'icon-text-fit': 'both',
          'icon-text-fit-padding': [1, 6, 1, 6],
          'text-field': ['get', 'price_short'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'text-anchor': 'bottom',
          'text-offset': [0, -0.65],
          'icon-allow-overlap': false,
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#ffffff' },
      });

      // ── pp.lv slāņi ──
      m.addLayer({
        id: 'listings-pp-dots',
        type: 'circle',
        source: 'listings-pts',
        minzoom: 13.5,
        filter: ['in', ['get', 'portal'], ['literal', ['pp.lv', 'pp']]],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13.5, 4.5, 15, 6.0, 17, 8.0],
          'circle-color': '#2f8a55',
          'circle-stroke-width': 2.0,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.95,
        },
      });
      m.addLayer({
        id: 'listings-pp-badges',
        type: 'symbol',
        source: 'listings-pts',
        minzoom: 13.5,
        filter: ['all', ['in', ['get', 'portal'], ['literal', ['pp.lv', 'pp']]], ['!=', ['get', 'price_short'], '']],
        layout: {
          'icon-image': 'badge-green',
          'icon-anchor': 'bottom',
          'icon-text-fit': 'both',
          'icon-text-fit-padding': [1, 6, 1, 6],
          'text-field': ['get', 'price_short'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'text-anchor': 'bottom',
          'text-offset': [0, -0.65],
          'icon-allow-overlap': false,
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#ffffff' },
      });

      // ── Izsoļu (auctions) avots un slāņi ──
      m.addSource('auctions-pts', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      m.addLayer({
        id: 'auctions-dots',
        type: 'circle',
        source: 'auctions-pts',
        minzoom: 12.5,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12.5, 4.5, 15, 6.5, 17, 8.5],
          'circle-color': '#c8860a',
          'circle-stroke-width': 2.0,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.95,
        },
      });
      m.addLayer({
        id: 'auctions-badges',
        type: 'symbol',
        source: 'auctions-pts',
        minzoom: 12.5,
        filter: ['!=', ['get', 'price_short'], ''],
        layout: {
          'icon-image': 'badge-amber',
          'icon-anchor': 'bottom',
          'icon-text-fit': 'both',
          'icon-text-fit-padding': [1, 6, 1, 6],
          'text-field': ['get', 'price_short'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'text-anchor': 'bottom',
          'text-offset': [0, -0.65],
          'icon-allow-overlap': false,
          'text-allow-overlap': false,
        },
        paint: { 'text-color': '#ffffff' },
      });

      const allListingLayers = [
        'listings-ss-dots', 'listings-ss-badges',
        'listings-c24-dots', 'listings-c24-badges',
        'listings-pp-dots', 'listings-pp-badges',
        'auctions-dots', 'auctions-badges',
      ];
      allListingLayers.forEach((lyr) => {
        m.on('mouseenter', lyr, () => { m.getCanvas().style.cursor = 'pointer'; });
        m.on('mouseleave', lyr, () => { m.getCanvas().style.cursor = ''; });
      });

      m.on('mouseenter', 'mix-one', () => { m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', 'mix-one', () => { m.getCanvas().style.cursor = ''; });

      m.on('render', updateMixMarkers);
      m.on('moveend', updateMixMarkers);
      m.on('idle', updateMixMarkers);
      m.on('data', (e: any) => {
        if (e.sourceId === 'mix-pts' && e.isSourceLoaded) {
          updateMixMarkers();
        }
      });

      // 1. Ātrā sludinājumu, izsoļu un darījumu punktu ielāde (apvieno klasteros un kartē)
      const updateViewportCount = () => {
        if (!m) return;
        const bounds = m.getBounds();
        if (!bounds) return;

        const activePortals = new Set<string>();
        if (showListingsSSRef.current) { activePortals.add('ss.com'); activePortals.add('ss'); }
        if (showListingsC24Ref.current) { activePortals.add('city24'); activePortals.add('city24.lv'); }
        if (showListingsPPRef.current) { activePortals.add('pp.lv'); activePortals.add('pp'); }

        let count = 0;
        for (const f of filteredListingsRef.current) {
          if (!activePortals.has(f.properties?.portal || 'ss.com')) continue;
          const coords = f.geometry?.coordinates;
          if (coords && bounds.contains([coords[0], coords[1]])) {
            count++;
          }
        }

        if (showAuctionsRef.current) {
          for (const f of filteredAuctionsRef.current) {
            const coords = f.geometry?.coordinates;
            if (coords && bounds.contains([coords[0], coords[1]])) {
              count++;
            }
          }
        }

        setVisibleListingsCount(count);
      };
      updateViewportCountRef.current = updateViewportCount;

      m.on('moveend', updateViewportCount);
      m.on('zoomend', updateViewportCount);

      const syncMixPoints = () => {
        const src = m.getSource('mix-pts') as maplibregl.GeoJSONSource | undefined;
        if (src) {
          const activePortals = new Set<string>();
          if (showListingsSSRef.current) { activePortals.add('ss.com'); activePortals.add('ss'); }
          if (showListingsC24Ref.current) { activePortals.add('city24'); activePortals.add('city24.lv'); }
          if (showListingsPPRef.current) { activePortals.add('pp.lv'); activePortals.add('pp'); }

          const activeListings = filteredListingsRef.current.filter((f) => activePortals.has(f.properties?.portal || 'ss.com'));
          const activeAuctions = showAuctionsRef.current ? filteredAuctionsRef.current : [];
          const activeTx = showTransactionsRef.current ? rawTxRef.current : [];

          src.setData({
            type: 'FeatureCollection',
            features: [...activeListings, ...activeAuctions, ...activeTx],
          });
          updateMixMarkers();
        }
      };
      syncMixPointsRef.current = syncMixPoints;

      const applyListingFilters = () => {
        if (!m) return;
        const currentDeal = listingDealRef.current;
        const currentCats = listingCatsRef.current;
        const pMin = filterPMinRef.current !== '' ? Number(filterPMinRef.current) : null;
        const pMax = filterPMaxRef.current !== '' ? Number(filterPMaxRef.current) : null;
        const aMin = filterAMinRef.current !== '' ? Number(filterAMinRef.current) : null;
        const aMax = filterAMaxRef.current !== '' ? Number(filterAMaxRef.current) : null;
        const rMin = filterRMinRef.current !== '' ? Number(filterRMinRef.current) : null;
        const rMax = filterRMaxRef.current !== '' ? Number(filterRMaxRef.current) : null;
        const fMin = filterFMinRef.current !== '' ? Number(filterFMinRef.current) : null;
        const fMax = filterFMaxRef.current !== '' ? Number(filterFMaxRef.current) : null;
        const noFirst = filterNoFirstRef.current;

        const hasRooms = currentCats.size === 0 || currentCats.has('flats') || currentCats.has('houses');
        const hasFloor = currentCats.size === 0 || currentCats.has('flats');

        const filteredL = rawListingsRef.current.filter((f) => {
          const props = f.properties || {};
          if (currentDeal !== 'all' && props.deal_type !== currentDeal) return false;
          if (currentCats.size > 0) {
            const normCat = normalizeCategory(props.category);
            if (!currentCats.has(normCat)) return false;
          }
          const price = Number(props.price) || 0;
          if (pMin !== null && price < pMin) return false;
          if (pMax !== null && price > pMax) return false;

          const area = Number(props.area || props.area_m2) || 0;
          if (aMin !== null && area < aMin) return false;
          if (aMax !== null && area > aMax) return false;

          if (hasRooms) {
            const rooms = Number(props.rooms) || 0;
            if (rMin !== null && rooms < rMin) return false;
            if (rMax !== null && rooms > rMax) return false;
          }

          if (hasFloor) {
            const floor = parseInt(String(props.floor), 10) || 0;
            if (fMin !== null && floor < fMin) return false;
            if (fMax !== null && floor > fMax) return false;
            if (noFirst && floor <= 1) return false;
          }

          return true;
        });

        // Izsoles (auctions)
        let filteredA: any[] = [];
        const aucExcluded = currentDeal === 'rent' || currentCats.size > 0 || aMin !== null || aMax !== null || (hasRooms && (rMin !== null || rMax !== null)) || (hasFloor && (fMin !== null || fMax !== null || noFirst));
        if (!aucExcluded) {
          filteredA = rawAuctionsRef.current.filter((f) => {
            const price = Number(f.properties?.current_bid || f.properties?.price_start || f.properties?.price) || 0;
            if (pMin !== null && price < pMin) return false;
            if (pMax !== null && price > pMax) return false;
            return true;
          });
        }

        filteredListingsRef.current = filteredL;
        filteredAuctionsRef.current = filteredA;

        const lSrc = m.getSource('listings-pts') as maplibregl.GeoJSONSource | undefined;
        if (lSrc) {
          lSrc.setData({ type: 'FeatureCollection', features: filteredL });
        }

        const aSrc = m.getSource('auctions-pts') as maplibregl.GeoJSONSource | undefined;
        if (aSrc) {
          aSrc.setData({ type: 'FeatureCollection', features: filteredA });
        }

        syncMixPoints();
        updateViewportCount();
      };
      applyListingFiltersRef.current = applyListingFilters;

      fetch(`${API_BASE}/api/listings?limit=30000`)
        .then((r) => {
          if (!r.ok) throw new Error('API listings offline');
          return r.json();
        })
        .then((data) => {
          if (!data || !Array.isArray(data.features)) return;
          rawListingsRef.current = data.features.map((f: any) => {
            const p = Number(f.properties?.price) || 0;
            const portal = f.properties?.portal || 'ss.com';
            return {
              ...f,
              properties: {
                ...f.properties,
                l: 1,
                t: 0,
                color: '#2f8a55',
                portal,
                price_short: formatShortPrice(p),
              },
            };
          });
          applyListingFilters();
        })
        .catch(() => {
          // Rezerves ielāde no lokālā keša, ja API vēl nav gatavs
          fetch('/data/listings-pts.json')
            .then((r) => r.json())
            .then((listingsData) => {
              if (!Array.isArray(listingsData)) return;
              rawListingsRef.current = listingsData.map((item: any) => {
                const pId = item[2] >> 1;
                const portal = pId === 1 ? 'city24' : pId === 2 ? 'pp.lv' : 'ss.com';
                const dealType = (item[2] & 1) === 1 ? 'rent' : 'sell';
                return {
                  type: 'Feature',
                  geometry: { type: 'Point', coordinates: [item[0], item[1]] },
                  properties: {
                    l: 1,
                    t: 0,
                    color: '#2f8a55',
                    portal,
                    deal_type: dealType,
                  },
                };
              });
              applyListingFilters();
            })
            .catch(() => {});
        });

      // Izsoļu (auctions) ielāde
      fetch(`${API_BASE}/api/auctions`)
        .then((r) => r.json())
        .then((aucData) => {
          if (!aucData || !Array.isArray(aucData.features)) return;
          rawAuctionsRef.current = aucData.features.map((f: any) => {
            const price = Number(f.properties?.current_bid || f.properties?.price_start || f.properties?.price) || 0;
            return {
              ...f,
              properties: {
                ...f.properties,
                l: 1,
                t: 0,
                is_auction: 1,
                color: '#c8860a',
                price_short: formatShortPrice(price),
              },
            };
          });
          applyListingFilters();
        })
        .catch(() => {});

      // 2. Fona darījumu punktu ielāde (apvieno ar sludinājumu klasteriem)
      fetch('/data/tx-pts.json')
        .then((r) => r.json())
        .then((txData) => {
          if (!Array.isArray(txData) || txData.length < 3) return;
          const loadedTx: any[] = [];
          const n = Math.floor(txData.length / 3);
          let x = 0;
          let y = 0;
          for (let i = 0; i < n; i++) {
            x += txData[3 * i];
            y += txData[3 * i + 1];
            loadedTx.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [x / 1e4, y / 1e4] },
              properties: { l: 0, t: 1, color: '#7b1fa2' },
            });
          }
          rawTxRef.current = loadedTx;
          syncMixPoints();
        })
        .catch(() => {});

      // 1. ZEMES VIENĪBAS (Parcels) - robežas no z11.5
      m.addSource('parcels', {
        type: 'vector',
        tiles: [`${TILES_BASE}/parcels/{z}/{x}/{y}`],
        minzoom: 11,
        maxzoom: 22,
      });

      m.addLayer({
        id: 'parcels-fill',
        type: 'fill',
        source: 'parcels',
        'source-layer': 'parcels',
        minzoom: 11.5,
        paint: {
          'fill-color': '#1b6b3a',
          'fill-opacity': [
            'interpolate', ['linear'], ['zoom'],
            11.5, 0.03,
            13, 0.06,
            15, 0.12,
          ],
        },
      });

      m.addLayer({
        id: 'parcels-line',
        type: 'line',
        source: 'parcels',
        'source-layer': 'parcels',
        minzoom: 11.5,
        paint: {
          'line-color': '#1b6b3a',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            11.5, 0.35,
            13, 0.7,
            15, 1.2,
            18, 2.0,
          ],
          'line-opacity': [
            'interpolate', ['linear'], ['zoom'],
            11.5, 0.45,
            13, 0.7,
            15, 0.85,
          ],
        },
      });

      // 2. ĒKAS (Buildings) - ēku korpusi no z12.5
      m.addSource('buildings', {
        type: 'vector',
        tiles: [`${TILES_BASE}/buildings/{z}/{x}/{y}`],
        minzoom: 12,
        maxzoom: 22,
      });

      m.addLayer({
        id: 'buildings-fill',
        type: 'fill',
        source: 'buildings',
        'source-layer': 'buildings',
        minzoom: 12.5,
        paint: {
          'fill-color': '#475569',
          'fill-opacity': [
            'interpolate', ['linear'], ['zoom'],
            12.5, 0.3,
            15, 0.7,
          ],
        },
      });

      m.addLayer({
        id: 'buildings-line',
        type: 'line',
        source: 'buildings',
        'source-layer': 'buildings',
        minzoom: 12.5,
        paint: {
          'line-color': '#1e293b',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            12.5, 0.5,
            16, 1.2,
          ],
          'line-opacity': 0.9,
        },
      });

      // 3. DARĪJUMI (Transactions) - detalizētie punkti no z13.5 (kā kadastrakarte.lv)
      // 3.1 Zemes vienību darījumi (zili)
      m.addSource('darijumi-zv', {
        type: 'vector',
        tiles: [`${TILES_BASE}/mv_tiles_zv/{z}/{x}/{y}`],
        minzoom: 13,
        maxzoom: 22,
      });
      m.addLayer({
        id: 'darijumi-zv-dots',
        type: 'circle',
        source: 'darijumi-zv',
        'source-layer': 'mv_tiles_zv',
        minzoom: 13.5,
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            13.5, 4.0,
            15, 5.5,
            17, 7.5,
          ],
          'circle-color': '#0277bd',
          'circle-stroke-width': 1.8,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9,
        },
      });

      // 3.2 Zemes vienību ar būvēm darījumi (oranži)
      m.addSource('darijumi-zvb', {
        type: 'vector',
        tiles: [`${TILES_BASE}/mv_tiles_zvb/{z}/{x}/{y}`],
        minzoom: 13,
        maxzoom: 22,
      });
      m.addLayer({
        id: 'darijumi-zvb-dots',
        type: 'circle',
        source: 'darijumi-zvb',
        'source-layer': 'mv_tiles_zvb',
        minzoom: 13.5,
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            13.5, 4.0,
            15, 5.5,
            17, 7.5,
          ],
          'circle-color': '#e65100',
          'circle-stroke-width': 1.8,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9,
        },
      });

      // 3.3 Telpu grupu (dzīvokļu) darījumi (violeti)
      m.addSource('darijumi-tg', {
        type: 'vector',
        tiles: [`${TILES_BASE}/mv_tiles_tg/{z}/{x}/{y}`],
        minzoom: 13,
        maxzoom: 22,
      });
      m.addLayer({
        id: 'darijumi-tg-dots',
        type: 'circle',
        source: 'darijumi-tg',
        'source-layer': 'mv_tiles_tg',
        minzoom: 13.5,
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            13.5, 4.0,
            15, 5.5,
            17, 7.5,
          ],
          'circle-color': '#7b1fa2',
          'circle-stroke-width': 1.8,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9,
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

      // 6. TAPIS ZONĒJUMS
      m.addSource('tapis-zone', {
        type: 'vector',
        tiles: [`${TILES_BASE}/tapis_zonejums/{z}/{x}/{y}`],
        minzoom: 6,
        maxzoom: 22,
      });
      const zoneColorExpr: any = [
        'case',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 3], 'DzS'], '#e8a888',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 3], 'DzM'], '#f5c870',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 3], 'DzD'], '#f5dca0',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 2], 'Dz'], '#f0c890',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 2], 'JC'], '#f0c060',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 2], 'TR'], '#d8d4c0',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 2], 'TA'], '#b8c8d8',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 2], 'DA'], '#b0d4a8',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 2], 'ML'], '#98c898',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 2], 'MR'], '#98c898',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 1], 'K'], '#f5e040',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 1], 'P'], '#c8a0d0',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 1], 'R'], '#c0b8d8',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 1], 'L'], '#cce090',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 1], 'M'], '#98c898',
        ['==', ['slice', ['coalesce', ['get', 'indekss'], ''], 0, 1], 'Ū'], '#a8c8e8',
        '#e0d8c8',
      ];
      m.addLayer({
        id: 'tapis-zone-fill',
        type: 'fill',
        source: 'tapis-zone',
        'source-layer': 'tapis_zonejums',
        minzoom: 6,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': zoneColorExpr,
          'fill-opacity': 0.45,
        },
      });
      m.addLayer({
        id: 'tapis-zone-line',
        type: 'line',
        source: 'tapis-zone',
        'source-layer': 'tapis_zonejums',
        minzoom: 12,
        layout: { visibility: 'none' },
        paint: {
          'line-color': '#7a5030',
          'line-width': 0.5,
          'line-opacity': 0.35,
        },
      });

      // 7. BŪVNIECĪBAS IECERES (BIS)
      m.addSource('construction', {
        type: 'vector',
        tiles: [`${TILES_BASE}/construction_cases/{z}/{x}/{y}`],
        minzoom: 8,
        maxzoom: 22,
      });
      m.addLayer({
        id: 'construction-fill',
        type: 'fill',
        source: 'construction',
        'source-layer': 'construction_cases',
        minzoom: 8,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': '#f59e0b',
          'fill-opacity': 0.4,
        },
      });
      m.addLayer({
        id: 'construction-line',
        type: 'line',
        source: 'construction',
        'source-layer': 'construction_cases',
        minzoom: 8,
        layout: { visibility: 'none' },
        paint: {
          'line-color': '#d97706',
          'line-width': 1.2,
        },
      });

      // 8. MEŽA NOGABALI (VMD)
      m.addSource('mezi-med', {
        type: 'vector',
        tiles: [`${TILES_BASE}/mv_mezi_med/{z}/{x}/{y}`],
        minzoom: 9,
        maxzoom: 13,
      });
      m.addLayer({
        id: 'mezi-med-fill',
        type: 'fill',
        source: 'mezi-med',
        'source-layer': 'mv_mezi_med',
        minzoom: 9,
        maxzoom: 13,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': '#2e7d32',
          'fill-opacity': 0.35,
        },
      });

      m.addSource('mezi', {
        type: 'vector',
        tiles: [`${TILES_BASE}/mvr_nogabali/{z}/{x}/{y}`],
        minzoom: 13,
        maxzoom: 22,
      });
      m.addLayer({
        id: 'mezi-fill',
        type: 'fill',
        source: 'mezi',
        'source-layer': 'mvr_nogabali',
        minzoom: 13,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': '#2e7d32',
          'fill-opacity': 0.45,
        },
      });
      m.addLayer({
        id: 'mezi-line',
        type: 'line',
        source: 'mezi',
        'source-layer': 'mvr_nogabali',
        minzoom: 13,
        layout: { visibility: 'none' },
        paint: {
          'line-color': '#1b5e20',
          'line-width': 0.6,
          'line-opacity': 0.4,
        },
      });

      // 9. CEĻU SERVITŪTI
      m.addSource('servituti', {
        type: 'vector',
        tiles: [`${TILES_BASE}/way_restrictions/{z}/{x}/{y}`],
        minzoom: 10,
        maxzoom: 22,
      });
      m.addLayer({
        id: 'servituti-line',
        type: 'line',
        source: 'servituti',
        'source-layer': 'way_restrictions',
        minzoom: 10,
        layout: { visibility: 'none' },
        paint: {
          'line-color': '#ff8f00',
          'line-width': 2.0,
          'line-opacity': 0.85,
        },
      });

      // 10. DABAS LIEGUMI
      m.addSource('protected', {
        type: 'vector',
        tiles: [`${TILES_BASE}/mv_protected_areas/{z}/{x}/{y}`],
        minzoom: 6,
        maxzoom: 22,
      });
      m.addLayer({
        id: 'protected-fill',
        type: 'fill',
        source: 'protected',
        'source-layer': 'mv_protected_areas',
        minzoom: 6,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': '#15803d',
          'fill-opacity': 0.25,
        },
      });
      m.addLayer({
        id: 'protected-line',
        type: 'line',
        source: 'protected',
        'source-layer': 'mv_protected_areas',
        minzoom: 6,
        layout: { visibility: 'none' },
        paint: {
          'line-color': '#166534',
          'line-width': 1.0,
        },
      });

      // 11. DIŽKOKI UN AKMEŅI
      m.addSource('nature', {
        type: 'vector',
        tiles: [`${TILES_BASE}/mv_nature_monuments/{z}/{x}/{y}`],
        minzoom: 9,
        maxzoom: 22,
      });
      m.addLayer({
        id: 'nature-dots',
        type: 'circle',
        source: 'nature',
        'source-layer': 'mv_nature_monuments',
        minzoom: 9,
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 4.5,
          'circle-color': '#15803d',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9,
        },
      });

      // 12. PLŪDU RISKA ZONAS
      m.addSource('flood-spring', {
        type: 'vector',
        tiles: [`${TILES_BASE}/flood_zone_spring_100y/{z}/{x}/{y}`],
        minzoom: 6,
        maxzoom: 22,
      });
      m.addLayer({
        id: 'flood-spring-fill',
        type: 'fill',
        source: 'flood-spring',
        'source-layer': 'flood_zone_spring_100y',
        minzoom: 6,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': '#0284c7',
          'fill-opacity': 0.35,
        },
      });

      m.addSource('flood-sea', {
        type: 'vector',
        tiles: [`${TILES_BASE}/flood_zone_sea_100y/{z}/{x}/{y}`],
        minzoom: 6,
        maxzoom: 22,
      });
      m.addLayer({
        id: 'flood-sea-fill',
        type: 'fill',
        source: 'flood-sea',
        'source-layer': 'flood_zone_sea_100y',
        minzoom: 6,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': '#0369a1',
          'fill-opacity': 0.4,
        },
      });

      // 13. DEGRADĒTĀS BŪVES
      m.addSource('degrading', {
        type: 'vector',
        tiles: [`${TILES_BASE}/degrading_buildings/{z}/{x}/{y}`],
        minzoom: 10,
        maxzoom: 22,
      });
      m.addLayer({
        id: 'degrading-fill',
        type: 'fill',
        source: 'degrading',
        'source-layer': 'degrading_buildings',
        minzoom: 10,
        layout: { visibility: 'none' },
        paint: {
          'fill-color': '#b91c1c',
          'fill-opacity': 0.45,
        },
      });

      // 14. SKOLAS UN BĒRNUDĀRZI
      m.addSource('schools', {
        type: 'geojson',
        data: `${DATA_BASE}/data/izgl.geojson`,
      });
      m.addLayer({
        id: 'schools-dots',
        type: 'circle',
        source: 'schools',
        minzoom: 8,
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 4.5,
          'circle-color': '#2563eb',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9,
        },
      });

      // 15. SABIEDRISKAIS TRANSPORTS
      m.addSource('transports', {
        type: 'geojson',
        data: `${DATA_BASE}/data/transports.geojson`,
      });
      m.addLayer({
        id: 'transports-dots',
        type: 'circle',
        source: 'transports',
        minzoom: 9,
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 3.5,
          'circle-color': '#0284c7',
          'circle-stroke-width': 1.0,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.85,
        },
      });

      // Interaktivitāte kursoram
      const interactiveLayers = [
        'parcels-fill',
        'buildings-fill',
        'darijumi-zv-dots',
        'darijumi-zvb-dots',
        'darijumi-tg-dots',
        'listings-dots',
        'energy-dots',
        'pollution-dots',
        'tapis-zone-fill',
        'construction-fill',
        'schools-dots',
        'nature-dots',
        'degrading-fill',
      ];
      interactiveLayers.forEach((layer) => {
        m.on('mouseenter', layer, () => {
          m.getCanvas().style.cursor = 'pointer';
        });
        m.on('mouseleave', layer, () => {
          m.getCanvas().style.cursor = '';
        });
      });

      // Klikšķa apstrāde darījumiem
      const txLayers = ['darijumi-zv-dots', 'darijumi-zvb-dots', 'darijumi-tg-dots'];
      txLayers.forEach((layerId) => {
        m.on('click', layerId, (e) => {
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties || {};
          const summa = Number(p.summa) ? `${Number(p.summa).toLocaleString('lv-LV')} €` : '';
          const datums = p.datums || '';
          const adrese = p.adrese || '';
          const zvKods = p.zv_kods || p.ipasuma_kods || '';
          const typeName = layerId.includes('zvb') ? 'Mājas / būves darījums' : (layerId.includes('zv') ? 'Zemes darījums' : 'Dzīvokļa darījums');
          const col = layerId.includes('zvb') ? '#e65100' : (layerId.includes('zv') ? '#0277bd' : '#7b1fa2');

          new maplibregl.Popup({ offset: 12 })
            .setLngLat(e.lngLat)
            .setHTML(`
              <div style="font-family: 'Hanken Grotesk', -apple-system, sans-serif; font-size: 13px; line-height: 1.4; padding: 4px;">
                <div style="display:flex; align-items:center; gap:6px; font-weight:700; color:${col}; margin-bottom:4px;">
                  <span style="width:10px; height:10px; border-radius:50%; background:${col}; display:inline-block;"></span>
                  ${typeName}
                </div>
                ${summa ? `<div style="font-size:16px; font-weight:800; color:#1e293b; margin-bottom:2px;">${summa}</div>` : ''}
                ${datums ? `<div style="color:#64748b; font-size:12px; margin-bottom:4px;">📅 ${datums}</div>` : ''}
                ${adrese ? `<div style="color:#334155; font-size:12px; margin-bottom:4px;">📍 ${adrese}</div>` : ''}
                ${zvKods ? `<div style="color:#0369a1; font-size:11px; font-family:monospace; background:#f0f9ff; padding:2px 6px; border-radius:4px; display:inline-block;">${zvKods}</div>` : ''}
              </div>
            `)
            .addTo(m);

          if (zvKods) {
            fetchParcelDetails(zvKods);
          }
        });
      });

      // Kopīga funkcija sludinājuma kartītes atvēršanai
      const openListingPopup = (f: any) => {
        const p = f.properties || {};
        const coords = (f.geometry as GeoJSON.Point).coordinates;
        const lng = coords[0];
        const lat = coords[1];

        if (currentPopupRef.current) {
          currentPopupRef.current.remove();
        }

        const price = Number(p.price) || 0;
        const firstPrice = Number(p.first_price) || price;
        const priceDiff = price - firstPrice;
        const priceDiffPct = firstPrice > 0 ? Math.round((priceDiff / firstPrice) * 100) : 0;
        const hasDrop = priceDiff < 0;
        const ppm2 = Number(p.price_per_m2) || 0;
        const area = Number(p.area) || 0;
        const rooms = Number(p.rooms) || 0;
        const floor = p.floor || '';
        const series = p.series || '';
        const portal = p.portal || 'ss.com';
        const dealType = p.deal_type === 'rent' ? 'rent' : 'sell';
        const dealLabel = dealType === 'rent' ? 'Izīrē' : 'Pārdod';
        const address = p.addr || p.address || 'Nekustamais īpašums';
        const days = Number(p.days || p.days_on_market) || 1;
        const url = p.url || 'https://www.ss.com/';
        const cadCode = p.cadastre_code || '';
        const thumb = p.thumb || '';
        const itemStr = encodeURIComponent(JSON.stringify({
          id: p.id,
          mid: p.mid || p.id,
          portal,
          addr: address,
          price,
          first_price: firstPrice,
          days,
          url,
          cadastre_code: cadCode,
        }));

        const popupId = 'lpc-' + (p.id || Math.round(Math.random() * 100000));

        let mediaHtml = '';
        if (thumb && !thumb.startsWith('/listings/thumbs/')) {
          mediaHtml = `
            <div class="lpc-media">
              <img class="lpc-img" src="${thumb}" alt="${address}" onerror="this.closest('.lpc-media').style.display='none';" />
              <div class="lpc-deal-tag ${dealType}">
                <span class="lpc-dot"></span>
                ${dealLabel}
              </div>
              <button class="lpc-close-btn" onclick="window.__closeCurrentPopup()" title="Aizvērt">✕</button>
            </div>
          `;
        } else {
          mediaHtml = `
            <div class="lpc-header-no-img">
              <div class="lpc-deal-tag ${dealType}">
                <span class="lpc-dot"></span>
                ${dealLabel}
              </div>
              <button class="lpc-close-btn" onclick="window.__closeCurrentPopup()" title="Aizvērt">✕</button>
            </div>
          `;
        }

        let dropHtml = '';
        if (hasDrop) {
          dropHtml = `
            <div class="lpc-drop-box">
              <div class="lpc-drop-left">
                <span class="lpc-drop-lbl">Cenas samazinājums</span>
                <span class="lpc-drop-amt">${priceDiff.toLocaleString('lv-LV')} € (${priceDiffPct}%)</span>
                <span class="lpc-drop-calc">Pirmā cena: ${firstPrice.toLocaleString('lv-LV')} €</span>
              </div>
              <div class="lpc-drop-right">
                <div class="lpc-days-val">${days}</div>
                <div class="lpc-days-lbl">dienas<br/>tirgū</div>
              </div>
            </div>
          `;
        } else if (days > 1) {
          dropHtml = `
            <div class="lpc-drop-box" style="background: #f8fafc; border-color: #e2e8f0;">
              <div class="lpc-drop-left">
                <span class="lpc-drop-lbl" style="color: #475569;">Stabila cena</span>
                <span class="lpc-drop-calc" style="color: #64748b;">Bez izmaiņām no pirmās dienas</span>
              </div>
              <div class="lpc-drop-right" style="border-left-color: #e2e8f0;">
                <div class="lpc-days-val" style="color: #334155;">${days}</div>
                <div class="lpc-days-lbl" style="color: #64748b;">dienas<br/>tirgū</div>
              </div>
            </div>
          `;
        }

        const specs = [];
        if (rooms > 0) specs.push({ val: `${rooms}`, lbl: 'Istabas' });
        if (area > 0) specs.push({ val: `${Math.round(area)} m²`, lbl: 'Platība' });
        if (floor) specs.push({ val: `${floor}`, lbl: 'Stāvs' });
        if (series) specs.push({ val: `${series}`, lbl: 'Sērija' });

        const specsHtml = specs.length > 0 ? `
          <div class="lpc-specs-row">
            ${specs.map((s) => `
              <div class="lpc-spec-box">
                <span class="lpc-spec-val">${s.val}</span>
                <span class="lpc-spec-lbl">${s.lbl}</span>
              </div>
            `).join('')}
          </div>
        ` : '';

        const html = `
          <div class="listing-popup-card">
            ${mediaHtml}
            <div class="lpc-body">
              <div class="lpc-price-row">
                <span class="lpc-price">${price.toLocaleString('lv-LV')} €</span>
                ${ppm2 > 0 ? `<span class="lpc-ppm2">${Math.round(ppm2).toLocaleString('lv-LV')} €/m²</span>` : ''}
              </div>
              <div class="lpc-address" title="${address}">${address}</div>
              ${specsHtml}
              ${dropHtml}
              <div class="lpc-actions-row">
                <button class="lpc-btn" onclick="window.__openListingHistory('${itemStr}')">
                  📈 Vēsture
                </button>
                <a class="lpc-btn lpc-btn-portal" href="${url}" target="_blank" rel="noopener noreferrer">
                  Atvērt ${portal} ↗
                </a>
              </div>
              <div class="lpc-report-section" id="${popupId}-report">
                <div class="lpc-report-header">Īpašuma pārbaudes signāli</div>
                <div id="${popupId}-signals-body" style="font-size: 11px; color: #64748b; text-align: center; padding: 6px;">
                  Pārbauda valsts reģistrus...
                </div>
              </div>
            </div>
          </div>
        `;

        const popup = new maplibregl.Popup({
          offset: 12,
          className: 'listing-popup-wrapper',
          maxWidth: '350px',
        })
          .setLngLat([lng, lat])
          .setHTML(html)
          .addTo(m);

        currentPopupRef.current = popup;

        // Dinamiskie signāli no mūsu Go API tieši no PostGIS
        const sigUrl = `${API_BASE}/api/popup-signals?code=${cadCode}&lng=${lng}&lat=${lat}`;
        fetch(sigUrl)
          .then((r) => r.json())
          .then((sigData) => {
            const bodyEl = document.getElementById(`${popupId}-signals-body`);
            if (!bodyEl) return;
            const signals = sigData.signals || [];
            const sourcesCount = sigData.sources || 11;

            let sigBoxesHtml = '';
            if (signals.length > 0) {
              sigBoxesHtml = `
                <div class="lpc-report-signals">
                  ${signals.slice(0, 3).map((s: any) => `
                    <div class="lpc-sig-item" title="${s.title || ''}">
                      <span class="lpc-sig-val">${s.n !== undefined ? s.n : (s.median ? s.median + ' €' : '✓')}</span>
                      <span class="lpc-sig-lbl">${s.title ? s.title.replace(/^\\d+\\s*/, '').slice(0, 16) : s.key}</span>
                    </div>
                  `).join('')}
                </div>
              `;
            } else {
              sigBoxesHtml = `
                <div style="font-size: 11.5px; color: #166534; font-weight: 600; padding: 4px 0;">
                  ✓ Pārbaudīti ${sourcesCount} valsts reģistri · Riski nav konstatēti
                </div>
              `;
            }

            bodyEl.innerHTML = `
              ${sigBoxesHtml}
              ${cadCode ? `
                <button class="lpc-btn lpc-btn-report" style="margin-top: 6px;" onclick="window.__openParcelReport('${cadCode}')">
                  Atvērt kadastra atskaiti (${cadCode}) ➔
                </button>
              ` : `
                <div style="font-size: 10px; color: #94a3b8; margin-top: 4px;">Pārbaudīti ${sourcesCount} valsts avoti</div>
              `}
            `;
          })
          .catch(() => {
            const bodyEl = document.getElementById(`${popupId}-signals-body`);
            if (bodyEl && cadCode) {
              bodyEl.innerHTML = `
                <button class="lpc-btn lpc-btn-report" onclick="window.__openParcelReport('${cadCode}')">
                  Atvērt kadastra atskaiti (${cadCode}) ➔
                </button>
              `;
            }
          });
      };

      const openAuctionPopup = (f: any) => {
        const p = f.properties || {};
        const coords = (f.geometry as GeoJSON.Point).coordinates;
        const lng = coords[0];
        const lat = coords[1];

        if (currentPopupRef.current) {
          currentPopupRef.current.remove();
        }

        const price = Number(p.current_bid || p.price_start || p.price) || 0;
        const startPrice = Number(p.price_start) || price;
        const address = p.addr || 'Nekustamā īpašuma izsole';
        const stage = p.stage || '';
        const state = p.state || 'Notiek izsole';
        const endsAt = p.ends_at ? new Date(p.ends_at).toLocaleDateString('lv-LV') : '';
        const url = p.url || `https://izsoles.ta.gov.lv/izsole/${p.id || ''}`;
        const cadCode = p.cadastre || p.parcel || '';

        const html = `
          <div class="listing-popup-card">
            <div class="lpc-header-no-img">
              <div class="lpc-deal-tag" style="background:#fef3c7; color:#b45309; border: 1px solid #fde68a;">
                <span class="lpc-dot" style="background:#d97706;"></span>
                Izsole ${stage ? `(${stage})` : ''}
              </div>
              <button class="lpc-close-btn" onclick="window.__closeCurrentPopup()" title="Aizvērt">✕</button>
            </div>
            <div class="lpc-body">
              <div class="lpc-price-row">
                <span class="lpc-price" style="color:#b45309;">${price.toLocaleString('lv-LV')} €</span>
                ${startPrice && startPrice !== price ? `<span class="lpc-ppm2">Sākuma: ${startPrice.toLocaleString('lv-LV')} €</span>` : ''}
              </div>
              <div class="lpc-address" title="${address}">${address}</div>
              <div style="font-size:12px; color:#64748b; margin-bottom:8px; display:flex; flex-direction:column; gap:3px;">
                <div><strong>Statuss:</strong> ${state}</div>
                ${endsAt ? `<div><strong>Noslēdzas:</strong> ${endsAt}</div>` : ''}
                ${cadCode ? `<div><strong>Kadastrs:</strong> ${cadCode}</div>` : ''}
              </div>
              <div class="lpc-actions-row">
                ${cadCode ? `
                  <button class="lpc-btn" onclick="window.__openParcelReport('${cadCode}')">
                    Kadastrs ➔
                  </button>
                ` : ''}
                <a class="lpc-btn lpc-btn-portal" style="background:#c8860a; color:#fff;" href="${url}" target="_blank" rel="noopener noreferrer">
                  Atvērt izsoli ↗
                </a>
              </div>
            </div>
          </div>
        `;

        const popup = new maplibregl.Popup({
          offset: 12,
          className: 'listing-popup-wrapper',
          maxWidth: '350px',
        })
          .setLngLat([lng, lat])
          .setHTML(html)
          .addTo(m);

        currentPopupRef.current = popup;
      };

      // Klikšķa apstrāde sludinājumu un izsoļu slāņiem
      const clickListingLayers = [
        'listings-ss-dots', 'listings-ss-badges',
        'listings-c24-dots', 'listings-c24-badges',
        'listings-pp-dots', 'listings-pp-badges',
      ];
      clickListingLayers.forEach((lyr) => {
        m.on('click', lyr, (e) => {
          if (!e.features || !e.features[0]) return;
          if (e.originalEvent) (e.originalEvent as any)._markerHandled = true;
          openListingPopup(e.features[0]);
        });
      });

      ['auctions-dots', 'auctions-badges'].forEach((lyr) => {
        m.on('click', lyr, (e) => {
          if (!e.features || !e.features[0]) return;
          if (e.originalEvent) (e.originalEvent as any)._markerHandled = true;
          openAuctionPopup(e.features[0]);
        });
      });

      // Klikšķa apstrāde atsevišķiem klasteru punktiem pie z < 14
      m.on('click', 'mix-one', (e) => {
        if (!e.features || !e.features[0]) return;
        if (e.originalEvent) (e.originalEvent as any)._markerHandled = true;
        const f = e.features[0];
        if (f.properties?.is_auction === 1) {
          openAuctionPopup(f);
        } else if (f.properties?.l === 1) {
          openListingPopup(f);
        } else if (f.properties?.t === 1) {
          const coords = (f.geometry as GeoJSON.Point).coordinates;
          new maplibregl.Popup({ offset: 12 })
            .setLngLat([coords[0], coords[1]])
            .setHTML(`
              <div style="font-family: 'Hanken Grotesk', -apple-system, sans-serif; font-size: 13px; padding: 4px;">
                <div style="display:flex; align-items:center; gap:6px; font-weight:700; color:#7b1fa2; margin-bottom:4px;">
                  <span style="width:10px; height:10px; border-radius:50%; background:#7b1fa2; display:inline-block;"></span>
                  VZD Darījumu objekts
                </div>
                <div style="color:#64748b; font-size:12px;">Pietuviniet karti, lai skatītu kadastra robežas un darījuma summu.</div>
              </div>
            `)
            .addTo(m);
        }
      });

      m.on('click', 'buildings-fill', (e) => {
        if ((e.originalEvent as any)?._markerHandled) return;
        if (!e.features || !e.features[0]) return;
        const parcelCode = e.features[0].properties?.parcelcode || e.features[0].properties?.parcel_code;
        if (parcelCode) {
          fetchParcelDetails(parcelCode);
        }
      });

      m.on('click', 'parcels-fill', (e) => {
        if ((e.originalEvent as any)?._markerHandled) return;
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

      // Klikšķa apstrāde TAPIS zonējumam
      m.on('click', 'tapis-zone-fill', (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        new maplibregl.Popup({ offset: 10 })
          .setLngLat(e.lngLat)
          .setHTML(`
            <div style="font-family: inherit; padding: 4px; font-size: 13px;">
              <div style="font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 700;">Teritorijas plānojums (TAPIS)</div>
              <div style="font-weight: 700; color: #1e293b; margin: 4px 0;">${p.nosaukums || p.indekss || 'Funkcionālā zona'}</div>
              ${p.indekss ? `<div style="font-size: 11px; color: #475569;">Indekss: <strong>${p.indekss}</strong></div>` : ''}
            </div>
          `)
          .addTo(m);
      });

      // Klikšķa apstrāde skolām
      m.on('click', 'schools-dots', (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        new maplibregl.Popup({ offset: 10 })
          .setLngLat(e.lngLat)
          .setHTML(`
            <div style="font-family: inherit; padding: 4px; font-size: 13px;">
              <div style="font-size: 11px; text-transform: uppercase; color: #2563eb; font-weight: 700;">Izglītības iestāde</div>
              <div style="font-weight: 700; color: #1e293b; margin: 4px 0;">${p.name || p.nosaukums || 'Skola'}</div>
              ${p.address ? `<div style="font-size: 11px; color: #64748b;">${p.address}</div>` : ''}
            </div>
          `)
          .addTo(m);
      });

      // Klikšķa apstrāde būvniecības iecerēm
      m.on('click', 'construction-fill', (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        new maplibregl.Popup({ offset: 10 })
          .setLngLat(e.lngLat)
          .setHTML(`
            <div style="font-family: inherit; padding: 4px; font-size: 13px;">
              <div style="font-size: 11px; text-transform: uppercase; color: #d97706; font-weight: 700;">Būvniecības iecere (BIS)</div>
              <div style="font-weight: 700; color: #1e293b; margin: 4px 0;">${p.nosaukums || p.name || 'Būvniecības projekts'}</div>
            </div>
          `)
          .addTo(m);
      });

      // Klikšķa apstrāde dabas pieminekļiem
      m.on('click', 'nature-dots', (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        new maplibregl.Popup({ offset: 10 })
          .setLngLat(e.lngLat)
          .setHTML(`
            <div style="font-family: inherit; padding: 4px; font-size: 13px;">
              <div style="font-size: 11px; text-transform: uppercase; color: #15803d; font-weight: 700;">Dabas piemineklis (DAP)</div>
              <div style="font-weight: 700; color: #1e293b; margin: 4px 0;">${p.name || p.nosaukums || 'Dižkoks / akmens'}</div>
            </div>
          `)
          .addTo(m);
      });

      // Klikšķa apstrāde degradētajām ēkām
      m.on('click', 'degrading-fill', (e) => {
        new maplibregl.Popup({ offset: 10 })
          .setLngLat(e.lngLat)
          .setHTML(`
            <div style="font-family: inherit; padding: 4px; font-size: 13px;">
              <div style="font-size: 11px; text-transform: uppercase; color: #b91c1c; font-weight: 700;">Degradēta ēka</div>
              <div style="font-weight: 700; color: #1e293b; margin: 4px 0;">Vidi degradējoša būve (grausts)</div>
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
    const setLVis = (layerId: string, show: boolean) => {
      if (map.current?.getLayer(layerId)) {
        map.current.setLayoutProperty(layerId, 'visibility', visibility(show));
      }
    };

    if (map.current.getLayer('satellite-layer')) {
      map.current.setLayoutProperty('satellite-layer', 'visibility', isSatellite ? 'visible' : 'none');
    }
    setLVis('parcels-fill', showParcels);
    setLVis('parcels-line', showParcels);
    setLVis('buildings-fill', showBuildings);
    setLVis('buildings-line', showBuildings);

    const txVis = visibility(showTransactions);
    ['darijumi-zv-dots', 'darijumi-zvb-dots', 'darijumi-tg-dots'].forEach((id) => {
      if (map.current?.getLayer(id)) {
        map.current.setLayoutProperty(id, 'visibility', txVis);
      }
    });

    setLVis('listings-ss-dots', showListingsSS);
    setLVis('listings-ss-badges', showListingsSS);
    setLVis('listings-c24-dots', showListingsC24);
    setLVis('listings-c24-badges', showListingsC24);
    setLVis('listings-pp-dots', showListingsPP);
    setLVis('listings-pp-badges', showListingsPP);
    setLVis('auctions-dots', showAuctions);
    setLVis('auctions-badges', showAuctions);

    setLVis('energy-dots', showEnergy);
    setLVis('pollution-dots', showPollution);
    setLVis('tapis-zone-fill', showZoning);
    setLVis('tapis-zone-line', showZoning);
    setLVis('construction-fill', showConstruction);
    setLVis('construction-line', showConstruction);
    setLVis('mezi-med-fill', showForests);
    setLVis('mezi-fill', showForests);
    setLVis('mezi-line', showForests);
    setLVis('servituti-line', showServituti);
    setLVis('protected-fill', showProtected);
    setLVis('protected-line', showProtected);
    setLVis('nature-dots', showNature);
    setLVis('flood-spring-fill', showFloods);
    setLVis('flood-sea-fill', showFloods);
    setLVis('degrading-fill', showDegrading);
    setLVis('schools-dots', showSchools);
    setLVis('transports-dots', showTransports);

    const anyListingsOn = showListingsSS || showListingsC24 || showListingsPP || showAuctions;
    const mixVis = (anyListingsOn || showTransactions) ? 'visible' : 'none';
    ['mix-clusters', 'mix-cluster-labels', 'mix-one'].forEach((id) => {
      if (map.current?.getLayer(id)) {
        map.current.setLayoutProperty(id, 'visibility', mixVis);
      }
    });
    syncMixPointsRef.current();
    updateMixMarkersRef.current();
  }, [
    showParcels,
    showBuildings,
    showTransactions,
    showListingsSS,
    showListingsC24,
    showListingsPP,
    showAuctions,
    showZoning,
    showConstruction,
    showForests,
    showServituti,
    showProtected,
    showNature,
    showFloods,
    showEnergy,
    showPollution,
    showDegrading,
    showSchools,
    showTransports,
    isSatellite,
  ]);

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
                <div id="lc-title">{activeLayersCount} no {totalLayersCount} slāņiem aktīvi</div>
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
                  <div id="lc-exp-status">
                    {activeLayersCount === 0
                      ? 'Nav izvēlēts neviens slānis'
                      : activeLayersCount === 1
                      ? 'Izvēlēts 1 slānis'
                      : `Izvēlēti ${activeLayersCount} slāņi`}
                  </div>
                </div>
                {activeLayersCount > 0 && (
                  <button id="lc-clear-btn" type="button" onClick={clearAllLayers}>
                    Notīrīt
                  </button>
                )}
                <button id="lc-collapse-btn" type="button" onClick={() => setIsLayersOpen(false)} title="Sakļaut slāņus">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6E6458" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="18 15 12 9 6 15" />
                  </svg>
                </button>
                <button id="lc-mob-close" type="button" onClick={() => setIsLayersOpen(false)}>✕</button>
              </div>

              {/* Slāņu kategorijas */}
              <div id="lc-cats">
                <div className="lc-section-label">
                  <b>Kategorijas</b>
                  <span>{totalLayersCount} slāņi</span>
                </div>

                <div className="lc-cats-list">
                  {/* 1. KADASTRS UN ĒKAS */}
                  <div className={`lc-cat ${openCats.has('kadastrs') ? 'open' : ''}`}>
                    <button
                      type="button"
                      className="lc-cat-hdr"
                      aria-expanded={openCats.has('kadastrs')}
                      onClick={() => toggleCat('kadastrs')}
                    >
                      <div className="lc-tile" style={{ background: '#eaf4ee', color: '#1b6b3a' }}>
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                        </svg>
                      </div>
                      <div className="lc-cat-txt">
                        <span className="lc-cat-name">Kadastrs un ēkas</span>
                      </div>
                      <span className={`lc-pill ${kadastrsActive > 0 ? 'active' : ''}`}>
                        {kadastrsActive > 0 ? `${kadastrsActive}/2` : '2'}
                      </span>
                      <span className="lc-cat-chev">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                    </button>
                    <div className="lc-layers">
                      <div className={`lc-row ${showParcels ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowParcels(!showParcels); }}>
                        <div className="lc-swatch" style={{ background: '#1b6b3a' }} />
                        <span className="lc-row-name">Zemes vienības (robežas)</span>
                        {currentZoom < 11.5 && <span className="lc-row-hint">pietuviniet</span>}
                        <button className={`lc-tog ${showParcels ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                      <div className={`lc-row ${showBuildings ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowBuildings(!showBuildings); }}>
                        <div className="lc-swatch" style={{ background: '#334155' }} />
                        <span className="lc-row-name">Ēkas un būves</span>
                        {currentZoom < 12.5 && <span className="lc-row-hint">pietuviniet</span>}
                        <button className={`lc-tog ${showBuildings ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* 2. SLUDINĀJUMI */}
                  <div className={`lc-cat ${openCats.has('sludinajumi') ? 'open' : ''}`}>
                    <button
                      type="button"
                      className="lc-cat-hdr"
                      aria-expanded={openCats.has('sludinajumi')}
                      onClick={() => toggleCat('sludinajumi')}
                    >
                      <div className="lc-tile" style={{ background: '#FBEADB', color: '#B25A22' }}>
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.3"/>
                        </svg>
                      </div>
                      <div className="lc-cat-txt">
                        <span className="lc-cat-name">Sludinājumi</span>
                      </div>
                      <span className={`lc-pill ${sludinajumiActive > 0 ? 'active' : ''}`}>
                        {sludinajumiActive > 0 ? `${sludinajumiActive}/4` : '4'}
                      </span>
                      <span className="lc-cat-chev">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                    </button>
                    <div className="lc-layers">
                      {/* Dzēst filtrus (redzams tikai tad, ja kāds filtrs ir ieslēgts) */}
                      {hasAnyFilter && (
                        <div className="lc-cat-tools">
                          <button
                            type="button"
                            className="lc-cat-clear"
                            onClick={(e) => {
                              e.stopPropagation();
                              clearAllListingFilters();
                            }}
                          >
                            Dzēst filtrus
                          </button>
                        </div>
                      )}

                      {/* ss.com */}
                      <div className={`lc-row ${showListingsSS ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowListingsSS(!showListingsSS); }}>
                        <div className="lc-swatch" style={{ background: '#2f8a55' }} />
                        <span className="lc-row-name">ss.com sludinājumi</span>
                        <button className={`lc-tog ${showListingsSS ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>

                      {/* city24 */}
                      <div className={`lc-row ${showListingsC24 ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowListingsC24(!showListingsC24); }}>
                        <div className="lc-swatch" style={{ background: '#2f8a55' }} />
                        <span className="lc-row-name">city24 sludinājumi</span>
                        <button className={`lc-tog ${showListingsC24 ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>

                      {/* pp.lv */}
                      <div className={`lc-row ${showListingsPP ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowListingsPP(!showListingsPP); }}>
                        <div className="lc-swatch" style={{ background: '#2f8a55' }} />
                        <span className="lc-row-name">pp.lv sludinājumi</span>
                        <button className={`lc-tog ${showListingsPP ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>

                      {/* Izsoles */}
                      <div className={`lc-row ${showAuctions ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowAuctions(!showAuctions); }}>
                        <div className="lc-swatch" style={{ background: '#c8860a' }} />
                        <span className="lc-row-name">Izsoles (ta.gov.lv)</span>
                        <button className={`lc-tog ${showAuctions ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>

                      {/* Segmentētā poga: Visi | Pārdod | Izīrē */}
                      <div className="lc-seg">
                        <button
                          type="button"
                          className={`lc-seg-b ${listingDeal === 'all' ? 'on' : ''}`}
                          onClick={(e) => { e.stopPropagation(); setListingDeal('all'); }}
                        >
                          Visi
                        </button>
                        <button
                          type="button"
                          className={`lc-seg-b ${listingDeal === 'sell' ? 'on' : ''}`}
                          onClick={(e) => { e.stopPropagation(); setListingDeal('sell'); }}
                        >
                          Pārdod
                        </button>
                        <button
                          type="button"
                          className={`lc-seg-b ${listingDeal === 'rent' ? 'on' : ''}`}
                          onClick={(e) => { e.stopPropagation(); setListingDeal('rent'); }}
                        >
                          Izīrē
                        </button>
                      </div>

                      {/* Kategoriju čipi */}
                      <div className="lf-cats">
                        {LISTING_CATS.map((cat) => (
                          <button
                            key={cat.key}
                            type="button"
                            className={`lc-chip ${listingCats.has(cat.key) ? 'on' : ''}`}
                            onClick={(e) => { e.stopPropagation(); toggleListingCat(cat.key); }}
                          >
                            {cat.name}
                          </button>
                        ))}
                      </div>

                      {/* Filtri poga un atrasto skaits šajā skatā */}
                      <div className="lst-foot">
                        <button
                          type="button"
                          className={`lf-btn ${isFiltersPanelOpen || activeDetailedFiltersCount > 0 ? 'on' : ''}`}
                          onClick={(e) => { e.stopPropagation(); setIsFiltersPanelOpen(!isFiltersPanelOpen); }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                            <line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>
                            <circle cx="9" cy="7" r="2.3" fill="#fff"/><circle cx="15" cy="12" r="2.3" fill="#fff"/><circle cx="8" cy="17" r="2.3" fill="#fff"/>
                          </svg>
                          Filtri
                          {activeDetailedFiltersCount > 0 && (
                            <span className="lf-btn-cnt">{activeDetailedFiltersCount}</span>
                          )}
                        </button>
                        <span className="lst-cnt">
                          {visibleListingsCount} šajā skatā
                        </span>
                      </div>

                      {/* Detalizētais filtru panelis */}
                      {isFiltersPanelOpen && (
                        <div className="lf-panel" onClick={(e) => e.stopPropagation()}>
                          {/* CENA */}
                          <div className="lf-row">
                            <div className="lf-row-lbl">Cena</div>
                            <div className="lf-range">
                              <input
                                type="number"
                                inputMode="numeric"
                                min="0"
                                placeholder="no"
                                value={filterPMin}
                                onChange={(e) => setFilterPMin(e.target.value)}
                              />
                              <span className="lf-dash">–</span>
                              <input
                                type="number"
                                inputMode="numeric"
                                min="0"
                                placeholder="līdz"
                                value={filterPMax}
                                onChange={(e) => setFilterPMax(e.target.value)}
                              />
                              <span className="lf-unit">€</span>
                            </div>
                          </div>

                          {/* PLATĪBA */}
                          <div className="lf-row">
                            <div className="lf-row-lbl">Platība</div>
                            <div className="lf-range">
                              <input
                                type="number"
                                inputMode="numeric"
                                min="0"
                                placeholder="no"
                                value={filterAMin}
                                onChange={(e) => setFilterAMin(e.target.value)}
                              />
                              <span className="lf-dash">–</span>
                              <input
                                type="number"
                                inputMode="numeric"
                                min="0"
                                placeholder="līdz"
                                value={filterAMax}
                                onChange={(e) => setFilterAMax(e.target.value)}
                              />
                              <span className="lf-unit">m²</span>
                            </div>
                          </div>

                          {/* ISTABAS */}
                          {showRoomsFields && (
                            <div className="lf-row">
                              <div className="lf-row-lbl">Istabas</div>
                              <div className="lf-range">
                                <select
                                  value={filterRMin}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setFilterRMin(val);
                                    if (val && filterRMax && Number(val) > Number(filterRMax)) {
                                      setFilterRMax('');
                                    }
                                  }}
                                >
                                  <option value="">no</option>
                                  {LF_ROOMS.map((r) => (
                                    <option key={r} value={r}>{r}</option>
                                  ))}
                                </select>
                                <span className="lf-dash">–</span>
                                <select
                                  value={filterRMax}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setFilterRMax(val);
                                    if (val && filterRMin && Number(filterRMin) > Number(val)) {
                                      setFilterRMin('');
                                    }
                                  }}
                                >
                                  <option value="">līdz</option>
                                  {LF_ROOMS.map((r) => (
                                    <option key={r} value={r}>{r}</option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          )}

                          {/* STĀVS UN NE PIRMAIS STĀVS */}
                          {showFlatFields && (
                            <>
                              <div className="lf-row">
                                <div className="lf-row-lbl">Stāvs</div>
                                <div className="lf-range">
                                  <select
                                    value={filterFMin}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setFilterFMin(val);
                                      if (val && Number(val) >= 2) {
                                        setFilterNoFirst(true);
                                      } else if (val === '' || Number(val) === 1) {
                                        setFilterNoFirst(false);
                                      }
                                      if (val && filterFMax && Number(val) > Number(filterFMax)) {
                                        setFilterFMax('');
                                      }
                                    }}
                                  >
                                    <option value="">no</option>
                                    {LF_FLOORS.map((f) => (
                                      <option key={f} value={f}>{f}</option>
                                    ))}
                                  </select>
                                  <span className="lf-dash">–</span>
                                  <select
                                    value={filterFMax}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setFilterFMax(val);
                                      if (val && filterFMin && Number(filterFMin) > Number(val)) {
                                        setFilterFMin('');
                                      }
                                    }}
                                  >
                                    <option value="">līdz</option>
                                    {LF_FLOORS.map((f) => (
                                      <option key={f} value={f}>{f}</option>
                                    ))}
                                  </select>
                                </div>
                              </div>

                              <div className="lf-row" style={{ marginTop: '-4px' }}>
                                <label className="lf-check">
                                  <input
                                    type="checkbox"
                                    checked={filterNoFirst}
                                    onChange={(e) => setFilterNoFirst(e.target.checked)}
                                  />
                                  Ne pirmais stāvs
                                </label>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 3. DARĪJUMI UN CENAS */}
                  <div className={`lc-cat ${openCats.has('darijumi') ? 'open' : ''}`}>
                    <button
                      type="button"
                      className="lc-cat-hdr"
                      aria-expanded={openCats.has('darijumi')}
                      onClick={() => toggleCat('darijumi')}
                    >
                      <div className="lc-tile" style={{ background: '#E1ECF8', color: '#2F64A8' }}>
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>
                        </svg>
                      </div>
                      <div className="lc-cat-txt">
                        <span className="lc-cat-name">Darījumi un cenas</span>
                      </div>
                      <span className={`lc-pill ${darijumiActive > 0 ? 'active' : ''}`}>
                        {darijumiActive > 0 ? `${darijumiActive}/1` : '1'}
                      </span>
                      <span className="lc-cat-chev">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                    </button>
                    <div className="lc-layers">
                      <div className={`lc-row ${showTransactions ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowTransactions(!showTransactions); }}>
                        <div className="lc-swatch" style={{ background: '#7b1fa2' }} />
                        <span className="lc-row-name">VZD darījumu vēsture</span>
                        <button className={`lc-tog ${showTransactions ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* 4. RISKI */}
                  <div className={`lc-cat ${openCats.has('riski') ? 'open' : ''}`}>
                    <button
                      type="button"
                      className="lc-cat-hdr"
                      aria-expanded={openCats.has('riski')}
                      onClick={() => toggleCat('riski')}
                    >
                      <div className="lc-tile" style={{ background: '#FBE3E0', color: '#B53628' }}>
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 10v4"/><path d="M12 17h.01"/>
                        </svg>
                      </div>
                      <div className="lc-cat-txt">
                        <span className="lc-cat-name">Riski</span>
                      </div>
                      <span className={`lc-pill ${riskiActive > 0 ? 'active' : ''}`}>
                        {riskiActive > 0 ? `${riskiActive}/3` : '3'}
                      </span>
                      <span className="lc-cat-chev">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                    </button>
                    <div className="lc-layers">
                      <div className={`lc-row ${showFloods ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowFloods(!showFloods); }}>
                        <div className="lc-swatch" style={{ background: '#0284c7' }} />
                        <span className="lc-row-name">LVĢMC Plūdu riska zonas</span>
                        <button className={`lc-tog ${showFloods ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                      <div className={`lc-row ${showPollution ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowPollution(!showPollution); }}>
                        <div className="lc-swatch" style={{ background: '#dc2626' }} />
                        <span className="lc-row-name">VVD Piesārņotās vietas</span>
                        <button className={`lc-tog ${showPollution ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                      <div className={`lc-row ${showDegrading ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowDegrading(!showDegrading); }}>
                        <div className="lc-swatch" style={{ background: '#b91c1c' }} />
                        <span className="lc-row-name">Vidi degradējošas ēkas (grausti)</span>
                        {currentZoom < 10 && <span className="lc-row-hint">pietuviniet</span>}
                        <button className={`lc-tog ${showDegrading ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* 5. PLĀNOJUMS UN BŪVNIECĪBA */}
                  <div className={`lc-cat ${openCats.has('planojums') ? 'open' : ''}`}>
                    <button
                      type="button"
                      className="lc-cat-hdr"
                      aria-expanded={openCats.has('planojums')}
                      onClick={() => toggleCat('planojums')}
                    >
                      <div className="lc-tile" style={{ background: '#ECE5F6', color: '#6A45A8' }}>
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 21h18"/><path d="M5 21V9l7-5 7 5v12"/><path d="M9.5 21v-6h5v6"/>
                        </svg>
                      </div>
                      <div className="lc-cat-txt">
                        <span className="lc-cat-name">Plānojums un būvniecība</span>
                      </div>
                      <span className={`lc-pill ${planojumsActive > 0 ? 'active' : ''}`}>
                        {planojumsActive > 0 ? `${planojumsActive}/2` : '2'}
                      </span>
                      <span className="lc-cat-chev">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                    </button>
                    <div className="lc-layers">
                      <div className={`lc-row ${showZoning ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowZoning(!showZoning); }}>
                        <div className="lc-swatch" style={{ background: '#e8a060' }} />
                        <span className="lc-row-name">TAPIS Teritorijas zonējums</span>
                        {currentZoom < 6 && <span className="lc-row-hint">pietuviniet</span>}
                        <button className={`lc-tog ${showZoning ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                      <div className={`lc-row ${showConstruction ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowConstruction(!showConstruction); }}>
                        <div className="lc-swatch" style={{ background: '#f59e0b' }} />
                        <span className="lc-row-name">Būvniecības ieceres (BIS)</span>
                        {currentZoom < 8 && <span className="lc-row-hint">pietuviniet</span>}
                        <button className={`lc-tog ${showConstruction ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* 6. DABA, MEŽS UN IEROBEŽOJUMI */}
                  <div className={`lc-cat ${openCats.has('daba') ? 'open' : ''}`}>
                    <button
                      type="button"
                      className="lc-cat-hdr"
                      aria-expanded={openCats.has('daba')}
                      onClick={() => toggleCat('daba')}
                    >
                      <div className="lc-tile" style={{ background: '#E1F0E3', color: '#2F7A45' }}>
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 22v-5"/><path d="M12 2 5.5 11h3.5L6 16h12l-3-5h3.5L12 2Z"/>
                        </svg>
                      </div>
                      <div className="lc-cat-txt">
                        <span className="lc-cat-name">Daba, mežs un ierobežojumi</span>
                      </div>
                      <span className={`lc-pill ${dabaActive > 0 ? 'active' : ''}`}>
                        {dabaActive > 0 ? `${dabaActive}/4` : '4'}
                      </span>
                      <span className="lc-cat-chev">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                    </button>
                    <div className="lc-layers">
                      <div className={`lc-row ${showForests ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowForests(!showForests); }}>
                        <div className="lc-swatch" style={{ background: '#2e7d32' }} />
                        <span className="lc-row-name">Meža nogabali (VMD)</span>
                        {currentZoom < 9 && <span className="lc-row-hint">pietuviniet</span>}
                        <button className={`lc-tog ${showForests ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                      <div className={`lc-row ${showServituti ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowServituti(!showServituti); }}>
                        <div className="lc-swatch" style={{ background: '#ff8f00' }} />
                        <span className="lc-row-name">Ceļu servitūti</span>
                        {currentZoom < 10 && <span className="lc-row-hint">pietuviniet</span>}
                        <button className={`lc-tog ${showServituti ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                      <div className={`lc-row ${showProtected ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowProtected(!showProtected); }}>
                        <div className="lc-swatch" style={{ background: '#15803d' }} />
                        <span className="lc-row-name">Dabas liegumi un mikroliegumi</span>
                        <button className={`lc-tog ${showProtected ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                      <div className={`lc-row ${showNature ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowNature(!showNature); }}>
                        <div className="lc-swatch" style={{ background: '#166534' }} />
                        <span className="lc-row-name">Dižkoki un dabas pieminekļi</span>
                        {currentZoom < 9 && <span className="lc-row-hint">pietuviniet</span>}
                        <button className={`lc-tog ${showNature ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* 7. APKĀRTNE */}
                  <div className={`lc-cat ${openCats.has('apkartne') ? 'open' : ''}`}>
                    <button
                      type="button"
                      className="lc-cat-hdr"
                      aria-expanded={openCats.has('apkartne')}
                      onClick={() => toggleCat('apkartne')}
                    >
                      <div className="lc-tile" style={{ background: '#DDF0EF', color: '#1F7A74' }}>
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/>
                        </svg>
                      </div>
                      <div className="lc-cat-txt">
                        <span className="lc-cat-name">Apkārtne</span>
                      </div>
                      <span className={`lc-pill ${apkartneActive > 0 ? 'active' : ''}`}>
                        {apkartneActive > 0 ? `${apkartneActive}/2` : '2'}
                      </span>
                      <span className="lc-cat-chev">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                    </button>
                    <div className="lc-layers">
                      <div className={`lc-row ${showSchools ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowSchools(!showSchools); }}>
                        <div className="lc-swatch" style={{ background: '#2563eb' }} />
                        <span className="lc-row-name">Skolas un bērnudārzi</span>
                        {currentZoom < 8 && <span className="lc-row-hint">pietuviniet</span>}
                        <button className={`lc-tog ${showSchools ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                      <div className={`lc-row ${showTransports ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowTransports(!showTransports); }}>
                        <div className="lc-swatch" style={{ background: '#0284c7' }} />
                        <span className="lc-row-name">Sabiedriskais transports</span>
                        {currentZoom < 9 && <span className="lc-row-hint">pietuviniet</span>}
                        <button className={`lc-tog ${showTransports ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* 8. ĒKA UN MAKSĀJUMI */}
                  <div className={`lc-cat ${openCats.has('eka') ? 'open' : ''}`}>
                    <button
                      type="button"
                      className="lc-cat-hdr"
                      aria-expanded={openCats.has('eka')}
                      onClick={() => toggleCat('eka')}
                    >
                      <div className="lc-tile" style={{ background: '#F5ECD6', color: '#8C6A16' }}>
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>
                        </svg>
                      </div>
                      <div className="lc-cat-txt">
                        <span className="lc-cat-name">Ēka un maksājumi</span>
                      </div>
                      <span className={`lc-pill ${ekaActive > 0 ? 'active' : ''}`}>
                        {ekaActive > 0 ? `${ekaActive}/2` : '2'}
                      </span>
                      <span className="lc-cat-chev">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </span>
                    </button>
                    <div className="lc-layers">
                      <div className={`lc-row ${showEnergy ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setShowEnergy(!showEnergy); }}>
                        <div className="lc-swatch" style={{ background: '#d97706' }} />
                        <span className="lc-row-name">BVKB Energosertifikāti (A+ līdz G)</span>
                        <button className={`lc-tog ${showEnergy ? 'on' : ''}`} type="button" tabIndex={-1}>
                          <div className="lc-tog-k" />
                        </button>
                      </div>
                      <div className={`lc-row ${isSatellite ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setIsSatellite(!isSatellite); }}>
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

      {/* Peldošā norāde pietuvināšanai, kad mērogs ir tālāks par zemes vienību robežām */}
      {currentZoom < 11.5 && showParcels && (
        <div
          id="zoom-guidance-pill"
          onClick={() => map.current?.zoomTo(12.5, { duration: 600 })}
          title="Nospiediet, lai pietuvinātu karti"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="11" y1="8" x2="11" y2="14" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
          <span>Pietuviniet, lai redzētu zemes vienību robežas</span>
        </div>
      )}

      {/* Sludinājuma cenu dinamikas un vēstures modālais logs */}
      {historyModal.open && (
        <div
          className="history-modal-overlay"
          onClick={() => setHistoryModal((prev) => ({ ...prev, open: false }))}
        >
          <div
            className="history-modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="hm-header">
              <div className="hm-title-box">
                <div className="hm-title">Sludinājuma cenu dinamika</div>
                <div className="hm-sub">
                  {historyModal.item?.addr || historyModal.history?.meta?.street || 'Nekustamais īpašums'} · {historyModal.item?.portal || historyModal.history?.portal || 'ss.com'}
                </div>
              </div>
              <button
                className="hm-close-btn"
                onClick={() => setHistoryModal((prev) => ({ ...prev, open: false }))}
                title="Aizvērt"
              >
                ✕
              </button>
            </div>

            <div className="hm-body">
              {historyModal.loading ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: '#64748b' }}>
                  <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>Ielādē sludinājuma vēsturi...</div>
                  <div style={{ fontSize: '13px' }}>Tiek apstrādāta cenu dinamika un arhīva fotogrāfijas</div>
                </div>
              ) : historyModal.history ? (
                <>
                  <div className="hm-stats-grid">
                    <div className="hm-stat-card">
                      <span className="hm-stat-val">
                        {(historyModal.history.last_price || historyModal.item?.price || 0).toLocaleString('lv-LV')} €
                      </span>
                      <span className="hm-stat-lbl">Pašreizējā cena</span>
                    </div>
                    <div className="hm-stat-card">
                      <span className="hm-stat-val">
                        {(historyModal.history.first_price || historyModal.item?.first_price || historyModal.history.last_price || 0).toLocaleString('lv-LV')} €
                      </span>
                      <span className="hm-stat-lbl">Pirmā cena</span>
                    </div>
                    <div className="hm-stat-card">
                      <span className="hm-stat-val">
                        {historyModal.history.days || historyModal.item?.days || 1}
                      </span>
                      <span className="hm-stat-lbl">Dienas tirgū</span>
                    </div>
                    <div className="hm-stat-card">
                      <span className="hm-stat-val">
                        {historyModal.history.drops || (historyModal.history.changes ? historyModal.history.changes.length - 1 : 0) || 0}
                      </span>
                      <span className="hm-stat-lbl">Cenu izmaiņas</span>
                    </div>
                  </div>

                  {historyModal.history.changes && historyModal.history.changes.length > 0 && (
                    <div className="hm-timeline-section">
                      <div className="hm-section-title">Cenu izmaiņu hronoloģija</div>
                      <div className="hm-timeline">
                        {[...historyModal.history.changes].reverse().map((ch: any, idx: number) => (
                          <div className="hm-tl-item" key={idx}>
                            <div className="hm-tl-date">
                              {ch.date ? new Date(ch.date).toLocaleDateString('lv-LV') : 'Sākotnēji'}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span className="hm-tl-price">{ch.price.toLocaleString('lv-LV')} €</span>
                              {ch.delta !== null && ch.delta !== undefined && ch.delta !== 0 && (
                                <span className={`hm-tl-badge ${ch.delta < 0 ? 'down' : 'up'}`}>
                                  {ch.delta > 0 ? '+' : ''}{ch.delta.toLocaleString('lv-LV')} €
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {historyModal.history.images && historyModal.history.images.length > 0 && (
                    <div className="hm-gallery-section">
                      <div className="hm-section-title">
                        Sludinājuma fotogrāfijas ({historyModal.history.images.length})
                      </div>
                      <div className="hm-gallery-grid">
                        {historyModal.history.images.map((imgUrl: string, idx: number) => (
                          <a
                            href={imgUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            key={idx}
                            title="Atvērt pilna izmēra attēlu"
                          >
                            <img
                              className="hm-gal-img"
                              src={imgUrl}
                              alt={`Attēls ${idx + 1}`}
                              loading="lazy"
                              onError={(e) => {
                                (e.target as HTMLElement).style.display = 'none';
                              }}
                            />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px' }}>
                    {historyModal.item?.cadastre_code ? (
                      <button
                        className="lpc-btn"
                        style={{ maxWidth: '220px' }}
                        onClick={() => {
                          setHistoryModal((prev) => ({ ...prev, open: false }));
                          fetchParcelDetails(historyModal.item.cadastre_code);
                        }}
                      >
                        Kadastra atskaite ➔
                      </button>
                    ) : <span />}
                    <a
                      className="lpc-btn lpc-btn-portal"
                      style={{ maxWidth: '240px' }}
                      href={historyModal.history.url || historyModal.item?.url || '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Atvērt {historyModal.item?.portal || 'portālā'} ↗
                    </a>
                  </div>
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: '30px 0', color: '#64748b' }}>
                  <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '6px' }}>Vēstures dati nav atrasti</div>
                  <div style={{ fontSize: '13px' }}>Šim sludinājumam vēl nav fiksētas cenu svārstības</div>
                  {historyModal.item?.url && (
                    <div style={{ marginTop: '16px' }}>
                      <a
                        className="lpc-btn lpc-btn-portal"
                        style={{ display: 'inline-flex' }}
                        href={historyModal.item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Atvērt sludinājumu {historyModal.item.portal || 'portālā'} ↗
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </>
  );
}
