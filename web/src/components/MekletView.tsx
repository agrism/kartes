import React, { useState, useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';

interface MekletStats {
  listings: number;
  deals: number;
  props: number;
  auctions: number;
}

interface MekletViewProps {
  onOpenListingModal?: (item: any) => void;
  onOpenParcelModal?: (code: string) => void;
  onOpenLightbox?: (images: string[], index?: number) => void;
  onClose?: () => void;
}

export const MekletView: React.FC<MekletViewProps> = ({
  onOpenListingModal,
  onOpenParcelModal,
  onOpenLightbox,
  onClose,
}) => {
  // 1. Galvenais režīms
  const [mode, setMode] = useState<'listings' | 'deals' | 'props' | 'auctions'>('listings');

  // 2. Dzīvā statistika
  const [stats, setStats] = useState<MekletStats>({
    listings: 21493,
    deals: 205092,
    props: 2527961,
    auctions: 10,
  });

  // 3. Filtru stāvoklis
  const [searchQuery, setSearchQuery] = useState('');
  const [town, setTown] = useState('');
  const [dealType, setDealType] = useState('sell'); // 'sell' | 'rent' | 'all'
  const [category, setCategory] = useState('all'); // 'flats' | 'houses' | 'plots' | 'commercial' | 'all'
  const [pmin, setPmin] = useState('');
  const [pmax, setPmax] = useState('');
  const [amin, setAmin] = useState('');
  const [amax, setAmax] = useState('');
  const [rmin, setRmin] = useState('');
  const [rmax, setRmax] = useState('');
  const [series, setSeries] = useState('');
  const [portal, setPortal] = useState('all');
  const [onlyDrop, setOnlyDrop] = useState(false);
  const [activeTab, setActiveTab] = useState<'active' | 'archive'>('active');

  // Kārtošana un paginācija
  const [sortBy, setSortBy] = useState('seen');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('DESC');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);

  // Split-screen karte
  const [showMap, setShowMap] = useState(false);
  const [followMap, setFollowMap] = useState(false);
  const [bbox, setBbox] = useState<string | null>(null);

  // Dati
  const [rows, setRows] = useState<any[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  // Autocomplete
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const acTimeoutRef = useRef<any>(null);

  // Kartes ref
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  // 1. Ielādējam statistiku
  useEffect(() => {
    fetch('/api/meklet-stats')
      .then((r) => r.json())
      .then((data) => {
        if (data && data.listings) {
          setStats({
            listings: data.listings,
            deals: data.deals,
            props: data.props,
            auctions: data.auctions,
          });
        }
      })
      .catch(() => {});
  }, []);

  // 2. Galvenā meklēšanas funkcija
  const executeSearch = useCallback(() => {
    setIsLoading(true);
    const p = new URLSearchParams();
    p.set('mode', mode);
    p.set('page', String(page));
    p.set('per', String(perPage));
    p.set('sort', sortBy);
    p.set('dir', sortDir);

    if (activeTab === 'archive') {
      p.set('active', '0');
    } else {
      p.set('active', '1');
    }

    if (searchQuery.trim()) p.set('q', searchQuery.trim());
    if (town.trim()) p.set('town', town.trim());
    if (dealType !== 'all') p.set('deal', dealType);
    if (category !== 'all') p.set('cat', category);
    if (portal !== 'all') p.set('portal', portal);
    if (pmin) p.set('pmin', pmin);
    if (pmax) p.set('pmax', pmax);
    if (amin) p.set('amin', amin);
    if (amax) p.set('amax', amax);
    if (rmin) p.set('rmin', rmin);
    if (rmax) p.set('rmax', rmax);
    if (series) p.set('series', series);
    if (onlyDrop) p.set('drop', '1');
    if (followMap && bbox) p.set('bbox', bbox);

    fetch(`/api/search?${p.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        setIsLoading(false);
        if (data && Array.isArray(data.rows)) {
          setRows(data.rows);
          setTotalRows(data.total || 0);
        } else {
          setRows([]);
          setTotalRows(0);
        }
      })
      .catch(() => {
        setIsLoading(false);
        setRows([]);
        setTotalRows(0);
      });
  }, [
    mode, page, perPage, sortBy, sortDir, activeTab, searchQuery, town,
    dealType, category, portal, pmin, pmax, amin, amax, rmin, rmax,
    series, onlyDrop, followMap, bbox
  ]);

  useEffect(() => {
    executeSearch();
  }, [executeSearch]);

  // Režīma maiņa atiestata lappusi
  const handleModeChange = (newMode: 'listings' | 'deals' | 'props' | 'auctions') => {
    setMode(newMode);
    setPage(1);
    if (newMode === 'deals') {
      setSortBy('date');
    } else if (newMode === 'props') {
      setSortBy('value');
    } else {
      setSortBy('seen');
    }
  };

  // Autocomplete ievade
  const handleQueryChange = (val: string) => {
    setSearchQuery(val);
    clearTimeout(acTimeoutRef.current);
    if (val.trim().length >= 2) {
      acTimeoutRef.current = setTimeout(() => {
        fetch(`/api/address-suggest?q=${encodeURIComponent(val.trim())}`)
          .then((r) => r.json())
          .then((data) => {
            if (Array.isArray(data)) {
              setSuggestions(data.slice(0, 8));
              setShowSuggestions(true);
            }
          })
          .catch(() => {});
      }, 250);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  };

  // Split-screen karte
  useEffect(() => {
    if (!showMap || !mapContainerRef.current) return;

    if (!mapInstanceRef.current) {
      const map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: 'https://tiles.openfreemap.org/styles/positron',
        center: [24.105, 56.95],
        zoom: 11,
      });

      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

      map.on('moveend', () => {
        if (followMap) {
          const b = map.getBounds();
          const bboxStr = `${b.getWest().toFixed(5)},${b.getSouth().toFixed(5)},${b.getEast().toFixed(5)},${b.getNorth().toFixed(5)}`;
          setBbox(bboxStr);
        }
      });

      mapInstanceRef.current = map;
    }

    // Atjauno marķierus
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const map = mapInstanceRef.current;
    if (!map) return;

    const bounds = new maplibregl.LngLatBounds();
    let hasCoords = false;

    rows.forEach((r) => {
      const lng = r.lng;
      const lat = r.lat;
      if (lng && lat && lng > 20 && lat > 55) {
        hasCoords = true;
        bounds.extend([lng, lat]);

        const el = document.createElement('div');
        el.className = 'meklet-map-marker';
        const color = mode === 'listings' ? '#2f8a55' : mode === 'deals' ? '#7b1fa2' : '#0277bd';
        el.style.backgroundColor = color;
        el.style.width = '12px';
        el.style.height = '12px';
        el.style.borderRadius = '50%';
        el.style.border = '2px solid white';
        el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
        el.style.cursor = 'pointer';

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([lng, lat])
          .addTo(map);

        el.addEventListener('click', () => {
          if (mode === 'listings' && onOpenListingModal) {
            onOpenListingModal(r);
          } else if (mode === 'props' && r.code && onOpenParcelModal) {
            onOpenParcelModal(r.code);
          } else if (mode === 'deals' && r.cadastre_code && onOpenParcelModal) {
            onOpenParcelModal(r.cadastre_code);
          }
        });

        markersRef.current.push(marker);
      }
    });

    if (hasCoords && !followMap) {
      map.fitBounds(bounds, { padding: 40, maxZoom: 15 });
    }
  }, [showMap, rows, mode, followMap, onOpenListingModal, onOpenParcelModal]);

  const totalPages = Math.max(1, Math.ceil(totalRows / perPage));

  return (
    <div className="meklet-container">
      {/* 1. Virsraksts un Režīmu josla */}
      <div className="meklet-header">
        <div className="meklet-header-left">
          <div className="meklet-title-row">
            <h1 className="meklet-title">
              {mode === 'listings' && 'Sludinājumi ar cenu vēsturi'}
              {mode === 'deals' && 'Valsts zemes dienesta reālie darījumi'}
              {mode === 'props' && 'Kadastra īpašumu un būvju reģistrs'}
              {mode === 'auctions' && 'Nekustamo īpašumu tiesu un TA izsoles'}
            </h1>
            {onClose && (
              <button type="button" className="meklet-close-btn" onClick={onClose} title="Atpakaļ uz karti">
                ✕ Aizvērt
              </button>
            )}
          </div>
          <p className="meklet-lead">
            {mode === 'listings' && 'Meklējiet nekustamos īpašumus ar reālo cenu vēsturi, atlaidēm un kadastra sasaisti visā Latvijā.'}
            {mode === 'deals' && 'Oficiālie Zemesgrāmatā reģistrētie pirkuma darījumi ar kvadrātmetra cenām un līgumu summām.'}
            {mode === 'props' && 'Vairāk nekā 2.5 miljoni zemes vienību un ēku kontūru ar kadastrālajām vērtībām un būvniecības gadiem.'}
            {mode === 'auctions' && 'Aktuālās tiesu izpildītāju un maksātnespējas izsoles ar sākumcenām un termiņiem.'}
          </p>
        </div>

        <div className="meklet-modes-col">
          <div className="meklet-modes">
            <button
              type="button"
              className={mode === 'listings' ? 'on' : ''}
              onClick={() => handleModeChange('listings')}
            >
              <span>Sludinājumi</span> <i>{stats.listings.toLocaleString()}</i>
            </button>
            <button
              type="button"
              className={mode === 'deals' ? 'on' : ''}
              onClick={() => handleModeChange('deals')}
            >
              <span>Darījumi</span> <i>{stats.deals.toLocaleString()}</i>
            </button>
            <button
              type="button"
              className={mode === 'props' ? 'on' : ''}
              onClick={() => handleModeChange('props')}
            >
              <span>Īpašumi</span> <i>{(stats.props / 1000000).toFixed(1)}M</i>
            </button>
            <button
              type="button"
              className={mode === 'auctions' ? 'on' : ''}
              onClick={() => handleModeChange('auctions')}
            >
              <span>Izsoles</span> <i>{stats.auctions}</i>
            </button>
          </div>
          <div className="meklet-live-note">
            <i className="meklet-live-dot" />
            <span>Dzīvie dati</span>
          </div>
        </div>
      </div>

      {/* 2. Filtru panelis */}
      <div className="meklet-filters">
        <div className="meklet-frow">
          {/* Meklēšanas lauks */}
          <div className="meklet-f meklet-f-grow">
            <label>Meklēt adresi, kadastru vai ielu</label>
            <div className="meklet-ac-wrap">
              <input
                type="text"
                placeholder="Piemēram: Dzelzavas 40, Rīga vai 01000722209"
                value={searchQuery}
                onChange={(e) => handleQueryChange(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && executeSearch()}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="meklet-ac-clear"
                  onClick={() => {
                    setSearchQuery('');
                    setSuggestions([]);
                    setShowSuggestions(false);
                  }}
                >
                  ✕
                </button>
              )}
              {showSuggestions && suggestions.length > 0 && (
                <div className="meklet-ac-list">
                  {suggestions.map((s, idx) => (
                    <div
                      key={idx}
                      className="meklet-ac-item"
                      onClick={() => {
                        setSearchQuery(s.address || s.text || '');
                        setShowSuggestions(false);
                        setPage(1);
                      }}
                    >
                      <div className="meklet-ac-main">{s.address || s.text}</div>
                      {s.town && <div className="meklet-ac-sub">{s.town}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Vieta / Pilsēta */}
          <div className="meklet-f">
            <label>Pilsēta / Novads</label>
            <input
              type="text"
              placeholder="Rīga, Jūrmala..."
              value={town}
              onChange={(e) => setTown(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && executeSearch()}
              style={{ width: '130px' }}
            />
          </div>

          {/* Darījuma tips (tikai sludinājumiem) */}
          {mode === 'listings' && (
            <div className="meklet-f">
              <label>Darījums</label>
              <div className="meklet-seg">
                <button
                  type="button"
                  className={dealType === 'sell' ? 'on' : ''}
                  onClick={() => { setDealType('sell'); setPage(1); }}
                >
                  Pārdod
                </button>
                <button
                  type="button"
                  className={dealType === 'rent' ? 'on' : ''}
                  onClick={() => { setDealType('rent'); setPage(1); }}
                >
                  Izīrē
                </button>
                <button
                  type="button"
                  className={dealType === 'all' ? 'on' : ''}
                  onClick={() => { setDealType('all'); setPage(1); }}
                >
                  Visi
                </button>
              </div>
            </div>
          )}

          {/* Kategorija */}
          {mode === 'listings' && (
            <div className="meklet-f">
              <label>Kategorija</label>
              <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
                <option value="all">Visas kategorijas</option>
                <option value="flats">Dzīvokļi</option>
                <option value="houses">Mājas</option>
                <option value="land">Zeme</option>
                <option value="commercial">Komerctelpas</option>
                <option value="farms">Lauku viensētas</option>
                <option value="forest">Mežs</option>
                <option value="garage">Garāžas</option>
              </select>
            </div>
          )}

          {/* Cenas diapazons */}
          {(mode === 'listings' || mode === 'deals' || mode === 'auctions') && (
            <div className="meklet-f">
              <label>Cena (€)</label>
              <div className="meklet-pair">
                <input
                  type="number"
                  placeholder="No"
                  value={pmin}
                  onChange={(e) => setPmin(e.target.value)}
                />
                <span>—</span>
                <input
                  type="number"
                  placeholder="Līdz"
                  value={pmax}
                  onChange={(e) => setPmax(e.target.value)}
                />
              </div>
            </div>
          )}

          {/* Platība */}
          <div className="meklet-f">
            <label>Platība (m²)</label>
            <div className="meklet-pair">
              <input
                type="number"
                placeholder="No"
                value={amin}
                onChange={(e) => setAmin(e.target.value)}
              />
              <span>—</span>
              <input
                type="number"
                placeholder="Līdz"
                value={amax}
                onChange={(e) => setAmax(e.target.value)}
              />
            </div>
          </div>

          {/* Istabas (sludinājumiem) */}
          {mode === 'listings' && (
            <div className="meklet-f">
              <label>Istabas</label>
              <div className="meklet-pair">
                <input
                  type="number"
                  placeholder="No"
                  value={rmin}
                  onChange={(e) => setRmin(e.target.value)}
                  style={{ width: '60px' }}
                />
                <span>—</span>
                <input
                  type="number"
                  placeholder="Līdz"
                  value={rmax}
                  onChange={(e) => setRmax(e.target.value)}
                  style={{ width: '60px' }}
                />
              </div>
            </div>
          )}

          {/* Cenu krituma čips */}
          {mode === 'listings' && (
            <div className="meklet-f">
              <label>&nbsp;</label>
              <button
                type="button"
                className={`meklet-chip ${onlyDrop ? 'on' : ''}`}
                onClick={() => { setOnlyDrop(!onlyDrop); setPage(1); }}
              >
                📉 Tikai ar atlaidi
              </button>
            </div>
          )}

          {/* Portāls */}
          {mode === 'listings' && (
            <div className="meklet-f">
              <label>Portāls</label>
              <select value={portal} onChange={(e) => { setPortal(e.target.value); setPage(1); }}>
                <option value="all">Visi portāli</option>
                <option value="ss.com">SS.com</option>
                <option value="city24.lv">City24.lv</option>
                <option value="izsoles.ta.gov.lv">Izsoles</option>
              </select>
            </div>
          )}

          {/* Meklēšanas poga */}
          <div className="meklet-f">
            <label>&nbsp;</label>
            <button type="button" className="meklet-btn-primary" onClick={() => { setPage(1); executeSearch(); }}>
              Meklēt
            </button>
          </div>
        </div>
      </div>

      {/* 3. Rezultātu kontroles josla */}
      <div className="meklet-bar">
        <div className="meklet-count">
          Atrasti <b>{totalRows.toLocaleString()}</b> {mode === 'listings' ? 'sludinājumi' : mode === 'deals' ? 'darījumi' : mode === 'props' ? 'īpašumi' : 'izsoles'}
        </div>

        {mode === 'listings' && (
          <div className="meklet-seg" style={{ height: '32px' }}>
            <button
              type="button"
              className={activeTab === 'active' ? 'on' : ''}
              onClick={() => { setActiveTab('active'); setPage(1); }}
              style={{ padding: '0 10px', fontSize: '12px' }}
            >
              Aktīvie
            </button>
            <button
              type="button"
              className={activeTab === 'archive' ? 'on' : ''}
              onClick={() => { setActiveTab('archive'); setPage(1); }}
              style={{ padding: '0 10px', fontSize: '12px' }}
            >
              Arhīvs
            </button>
          </div>
        )}

        <div className="meklet-bar-right">
          {/* Kārtošana */}
          <div className="meklet-sort-select">
            <span>Kārtot:</span>
            <select
              value={sortBy}
              onChange={(e) => {
                setSortBy(e.target.value);
                setPage(1);
              }}
            >
              {mode === 'listings' && (
                <>
                  <option value="seen">Pēdējo reizi manīts</option>
                  <option value="date">Publicēšanas datums</option>
                  <option value="price_asc">Lētākie vispirms</option>
                  <option value="price_desc">Dārgākie vispirms</option>
                  <option value="ppm_asc">Zemākā €/m² cena</option>
                  <option value="ppm_desc">Augstākā €/m² cena</option>
                  <option value="drop">Lielākā atlaide (%)</option>
                  <option value="area">Lielākā platība</option>
                </>
              )}
              {mode === 'deals' && (
                <>
                  <option value="date">Darījuma datums</option>
                  <option value="price">Lielākā summa</option>
                  <option value="ppm">Augstākā €/m² cena</option>
                  <option value="area">Lielākā platība</option>
                </>
              )}
              {mode === 'props' && (
                <>
                  <option value="value">Kadastrālā vērtība</option>
                  <option value="area">Zemes platība</option>
                </>
              )}
            </select>
          </div>

          {/* Kartes poga */}
          <button
            type="button"
            className={`meklet-map-btn ${showMap ? 'on' : ''}`}
            onClick={() => setShowMap(!showMap)}
          >
            🗺️ {showMap ? 'Paslēpt karti' : 'Rādīt kartē'}
          </button>

          {/* Seko kartei checkbox */}
          {showMap && (
            <label className="meklet-follow-label" title="Pārvietojot karti, tabula automātiski filtrē redzamos objektus">
              <input
                type="checkbox"
                checked={followMap}
                onChange={(e) => setFollowMap(e.target.checked)}
              />
              <span>Seko kartei</span>
            </label>
          )}
        </div>
      </div>

      {/* 4. Galvenais satura apgabals (Tabula + iespējamā karte) */}
      <div className={`meklet-content ${showMap ? 'split' : 'full'}`}>
        <div className="meklet-table-wrap">
          {isLoading ? (
            <div className="meklet-loading">
              <div className="meklet-spinner" />
              <span>Ielādē datus...</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="meklet-empty">
              <p>Nav atrasts neviens ieraksts ar norādītajiem filtriem.</p>
              <button
                type="button"
                className="meklet-btn-primary"
                onClick={() => {
                  setSearchQuery('');
                  setTown('');
                  setCategory('all');
                  setOnlyDrop(false);
                  setPmin('');
                  setPmax('');
                  setPage(1);
                  executeSearch();
                }}
              >
                Notīrīt filtrus
              </button>
            </div>
          ) : (
            <table className="meklet-table">
              <thead>
                {mode === 'listings' && (
                  <tr>
                    <th style={{ width: '80px' }}>Foto</th>
                    <th>Objekts un Adrese</th>
                    <th style={{ width: '130px' }}>Cena</th>
                    <th style={{ width: '100px' }}>Cena / m²</th>
                    <th style={{ width: '90px' }}>Platība</th>
                    <th style={{ width: '80px' }}>Istabas</th>
                    <th style={{ width: '80px' }}>Stāvs</th>
                    <th style={{ width: '110px' }}>Tirgū</th>
                    <th style={{ width: '80px' }}>Avots</th>
                  </tr>
                )}
                {mode === 'deals' && (
                  <tr>
                    <th style={{ width: '110px' }}>Datums</th>
                    <th>Adrese un Objekts</th>
                    <th style={{ width: '130px' }}>Darījuma summa</th>
                    <th style={{ width: '100px' }}>Cena / m²</th>
                    <th style={{ width: '100px' }}>Platība</th>
                    <th style={{ width: '110px' }}>Kadastrs</th>
                  </tr>
                )}
                {mode === 'props' && (
                  <tr>
                    <th style={{ width: '130px' }}>Kadastra kods</th>
                    <th>Adrese</th>
                    <th style={{ width: '140px' }}>Kadastrālā vērtība</th>
                    <th style={{ width: '110px' }}>Platība</th>
                    <th style={{ width: '120px' }}>Statuss</th>
                  </tr>
                )}
                {mode === 'auctions' && (
                  <tr>
                    <th style={{ width: '80px' }}>Foto</th>
                    <th>Adrese un Objekts</th>
                    <th style={{ width: '130px' }}>Sākumcena</th>
                    <th style={{ width: '110px' }}>Kadastrs</th>
                    <th style={{ width: '120px' }}>Termiņš</th>
                    <th style={{ width: '90px' }}>Saite</th>
                  </tr>
                )}
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id || row.code}
                    className="meklet-tr"
                    onClick={() => {
                      if (mode === 'listings' && onOpenListingModal) {
                        onOpenListingModal(row);
                      } else if (mode === 'props' && row.code && onOpenParcelModal) {
                        onOpenParcelModal(row.code);
                      } else if (mode === 'deals' && row.cadastre_code && onOpenParcelModal) {
                        onOpenParcelModal(row.cadastre_code);
                      }
                    }}
                  >
                    {mode === 'listings' && (
                      <>
                        <td className="meklet-td-photo">
                          {row.images && row.images.length > 0 ? (
                            <div
                              className="meklet-thumb-box"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (onOpenLightbox) {
                                  onOpenLightbox(row.images, 0);
                                } else if (onOpenListingModal) {
                                  onOpenListingModal(row);
                                }
                              }}
                              title="Pietuvināt attēlus"
                              style={{ cursor: 'pointer' }}
                            >
                              <img src={row.images[0]} alt="" loading="lazy" />
                              {row.images.length > 1 && (
                                <span className="meklet-photo-count">📷 {row.images.length}</span>
                              )}
                            </div>
                          ) : (
                            <div className="meklet-thumb-placeholder">Nav foto</div>
                          )}
                        </td>
                        <td className="meklet-td-main">
                          <div className="meklet-item-title">{row.title || row.addr_raw || 'Īpašums'}</div>
                          <div className="meklet-item-addr">
                            📍 {row.addr_town ? `${row.addr_town}, ` : ''}{row.addr_raw || ''}
                            {row.cadastre_code && <span className="meklet-cad-tag">{row.cadastre_code}</span>}
                          </div>
                        </td>
                        <td className="meklet-td-price">
                          <div className="meklet-price-val">{row.price.toLocaleString()} €</div>
                          {row.drop_pct && (
                            <span className="meklet-drop-badge" title={`Sākotnējā cena: ${row.first_price?.toLocaleString()} €`}>
                              📉 {row.drop_pct}%
                            </span>
                          )}
                        </td>
                        <td>{row.price_per_m2 ? `${Math.round(row.price_per_m2)} €/m²` : '—'}</td>
                        <td>{row.area ? `${row.area} m²` : '—'}</td>
                        <td>{row.rooms ? `${row.rooms} ist.` : '—'}</td>
                        <td>{row.floor ? `${row.floor}${row.total_floors ? `/${row.total_floors}` : ''}` : '—'}</td>
                        <td>
                          <span className="meklet-days-badge">{row.days || 1} d.</span>
                        </td>
                        <td>
                          <span className={`meklet-portal-pill ${row.portal === 'ss.com' ? 'ss' : row.portal === 'city24.lv' ? 'c24' : 'auc'}`}>
                            {row.portal === 'ss.com' ? 'SS.com' : row.portal === 'city24.lv' ? 'City24' : 'Izsole'}
                          </span>
                        </td>
                      </>
                    )}

                    {mode === 'deals' && (
                      <>
                        <td>📅 {row.datums}</td>
                        <td className="meklet-td-main">
                          <div className="meklet-item-title">{row.adrese || 'Īpašuma darījums'}</div>
                          <div className="meklet-item-addr">Tips: {row.property_type || 'Nekustamais īpašums'}</div>
                        </td>
                        <td className="meklet-td-price">
                          <div className="meklet-price-val">{row.summa.toLocaleString()} €</div>
                        </td>
                        <td>{row.ppm ? `${Math.round(row.ppm)} €/m²` : '—'}</td>
                        <td>{row.area ? `${row.area} m²` : '—'}</td>
                        <td><code>{row.cadastre_code || '—'}</code></td>
                      </>
                    )}

                    {mode === 'props' && (
                      <>
                        <td><code>{row.code}</code></td>
                        <td className="meklet-td-main">
                          <div className="meklet-item-title">{row.address || 'Zemes vienība'}</div>
                        </td>
                        <td className="meklet-td-price">
                          <div className="meklet-price-val">{row.kad_value ? `${Math.round(row.kad_value).toLocaleString()} €` : '—'}</div>
                        </td>
                        <td>{row.area ? `${Math.round(row.area)} m²` : '—'}</td>
                        <td>{row.status || 'Aktīvs'}</td>
                      </>
                    )}

                    {mode === 'auctions' && (
                      <>
                        <td className="meklet-td-photo">
                          {row.images && row.images.length > 0 ? (
                            <img
                              src={row.images[0]}
                              alt=""
                              onClick={(e) => {
                                e.stopPropagation();
                                if (onOpenLightbox) onOpenLightbox(row.images, 0);
                              }}
                              style={{ width: '60px', height: '45px', objectFit: 'cover', borderRadius: '4px', cursor: 'pointer' }}
                              title="Pietuvināt attēlu"
                            />
                          ) : (
                            <div className="meklet-thumb-placeholder">Izsole</div>
                          )}
                        </td>
                        <td className="meklet-td-main">
                          <div className="meklet-item-title">{row.title || row.addr_raw}</div>
                          <div className="meklet-item-addr">{row.addr_raw}</div>
                        </td>
                        <td className="meklet-td-price">
                          <div className="meklet-price-val">{row.price.toLocaleString()} €</div>
                        </td>
                        <td><code>{row.cadastre_code || '—'}</code></td>
                        <td>{row.published_at ? row.published_at.slice(0, 10) : 'Notiek'}</td>
                        <td>
                          {row.url && (
                            <a href={row.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="meklet-ext-link">
                              Atvērt ↗
                            </a>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Paginācija */}
          {totalPages > 1 && (
            <div className="meklet-pagination">
              <button
                type="button"
                className="meklet-pg-btn"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                ← Iepriekšējā
              </button>
              <span className="meklet-pg-info">
                Lapa <b>{page}</b> no <b>{totalPages}</b>
              </span>
              <button
                type="button"
                className="meklet-pg-btn"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                Nākamā →
              </button>
            </div>
          )}
        </div>

        {/* 5. Split-screen Karte labajā pusē */}
        {showMap && (
          <div className="meklet-map-column">
            <div className="meklet-map-inner" ref={mapContainerRef} />
          </div>
        )}
      </div>
    </div>
  );
};
