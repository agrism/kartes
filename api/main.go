package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var dbPool *pgxpool.Pool

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgresql://kartes:kartes_secret_password@db:5432/kartes"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var err error
	config, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		log.Fatalf("Nevar nolasīt datubāzes konfigurāciju: %v", err)
	}
	config.MaxConns = 25
	config.MinConns = 5

	dbPool, err = pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		log.Fatalf("Nevar izveidot savienojumu pūlu: %v", err)
	}
	defer dbPool.Close()

	if err := dbPool.Ping(ctx); err != nil {
		log.Printf("Brīdinājums: Datubāze vēl nav pilnībā gatava pingam: %v", err)
	} else {
		log.Println("Veiksmīgi izveidots savienojums ar PostgreSQL/PostGIS!")
	}

	mux := http.NewServeMux()

	// Reģistrē maršrutus
	mux.HandleFunc("/api/health", handleHealth)
	mux.HandleFunc("/api/parcel-info", handleParcelInfo)
	mux.HandleFunc("/api/building-info", handleBuildingInfo)
	mux.HandleFunc("/api/address-suggest", handleAddressSuggest)
	mux.HandleFunc("/api/transactions", handleTransactions)
	mux.HandleFunc("/api/listings", handleListingsGeoJSON)
	mux.HandleFunc("/api/listings-geojson", handleListingsGeoJSON)
	mux.HandleFunc("/api/listing-history", handleListingHistory)
	mux.HandleFunc("/api/popup-signals", handlePopupSignals)
	mux.HandleFunc("/api/auctions", handleAuctions)
	mux.HandleFunc("/api/auctions-geojson", handleAuctions)
	mux.HandleFunc("/api/scraper-status", handleScraperStatus)
	mux.HandleFunc("/api/scraper-runs", handleScraperStatus)
	mux.HandleFunc("/api/tx-pts", handleTxPts)
	mux.HandleFunc("/api/meklet-stats", handleMekletStats)
	mux.HandleFunc("/api/search", handleUnifiedSearch)

	handler := enableCORS(mux)

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      handler,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	go func() {
		log.Printf("Kartes Go API serveris palaists uz porta :%s\n", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Servera kļūda: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Serveris tiek apturēts...")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("Servera apturēšanas kļūda: %v", err)
	}
	log.Println("Serveris apturēts veiksmīgi.")
}

func enableCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	dbStatus := "connected"
	if err := dbPool.Ping(r.Context()); err != nil {
		dbStatus = "error: " + err.Error()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":   "ok",
		"database": dbStatus,
		"time":     time.Now().Format(time.RFC3339),
		"engine":   "Go (net/http + pgx/v5)",
	})
}

// 1. Meklējam ēkas energoefektivitātes sertifikātu un piesārņojumu no lokālās DB
type EnergyCert struct {
	Class        string   `json:"class"`
	HeatingKwhM2 *float64 `json:"heating_kwh_m2,omitempty"`
	ValidUntil   string   `json:"valid_until,omitempty"`
	Status       string   `json:"status,omitempty"`
}

type PollutionNearby struct {
	Name      string  `json:"name"`
	Category  string  `json:"category"`
	SiteType  string  `json:"site_type"`
	DistanceM float64 `json:"distance_m"`
}

func getParcelLocalEnrichment(ctx context.Context, code string) (*EnergyCert, []PollutionNearby) {
	var cert *EnergyCert
	var eClass, eValid, eStatus string
	var eKwh *float64
	eErr := dbPool.QueryRow(ctx, `
		SELECT COALESCE(energy_class, ''), COALESCE(to_char(valid_until, 'YYYY-MM-DD'), ''), COALESCE(status, ''), heating_kwh_m2
		FROM public.energy_certificates
		WHERE parcel_code = $1 OR building_code LIKE $1 || '%'
		ORDER BY (CASE WHEN status = 'Ir spēkā' THEN 1 ELSE 2 END), valid_until DESC NULLS LAST
		LIMIT 1;
	`, code).Scan(&eClass, &eValid, &eStatus, &eKwh)
	if eErr == nil && eClass != "" {
		cert = &EnergyCert{
			Class:        eClass,
			HeatingKwhM2: eKwh,
			ValidUntil:   eValid,
			Status:       eStatus,
		}
	}

	pollutionList := make([]PollutionNearby, 0)
	pRows, pErr := dbPool.Query(ctx, `
		SELECT ps.name, ps.category, ps.site_type, ROUND(ST_Distance(p.geom, ps.geom)) as dist
		FROM public.pollution_sites ps, public.parcels p
		WHERE p.code = $1 AND p.geom IS NOT NULL AND ST_DWithin(p.geom, ps.geom, 500)
		ORDER BY dist ASC
		LIMIT 3;
	`, code)
	if pErr == nil {
		defer pRows.Close()
		for pRows.Next() {
			var ps PollutionNearby
			if err := pRows.Scan(&ps.Name, &ps.Category, &ps.SiteType, &ps.DistanceM); err == nil {
				pollutionList = append(pollutionList, ps)
			}
		}
	}
	return cert, pollutionList
}

// /api/parcel-info?code=01000070001
func handleParcelInfo(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Parametrs 'code' ir obligāts"})
		return
	}

	// 1. Mēģinām iegūt pilno kadastra atskaiti no kadastrakarte.lv ar 3s noildzi
	client := &http.Client{Timeout: 3 * time.Second}
	upReq, err := http.NewRequestWithContext(r.Context(), "GET", "https://kadastrakarte.lv/api/parcel-info.php?code="+url.QueryEscape(code), nil)
	if err == nil {
		upReq.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
		upReq.Header.Set("Referer", "https://kadastrakarte.lv/")
		resp, dErr := client.Do(upReq)
		if dErr == nil && resp.StatusCode == http.StatusOK {
			defer resp.Body.Close()
			body, rErr := io.ReadAll(resp.Body)
			if rErr == nil && len(body) > 30 && strings.Contains(string(body), `"parcel"`) {
				var upstreamData map[string]any
				if jErr := json.Unmarshal(body, &upstreamData); jErr == nil {
					// Formatējam adresi kā vienotu teksta rindu, lai React nerastos kļūdas
					var addrStr string
					if addrObj, ok := upstreamData["address"].(map[string]any); ok {
						parts := []string{}
						street, _ := addrObj["street"].(string)
						house, _ := addrObj["house"].(string)
						town, _ := addrObj["town"].(string)
						postIdx, _ := addrObj["post_index"].(string)
						sh := strings.TrimSpace(street + " " + house)
						if sh != "" {
							parts = append(parts, sh)
						}
						if town != "" {
							parts = append(parts, town)
						}
						if postIdx != "" {
							parts = append(parts, postIdx)
						}
						addrStr = strings.Join(parts, ", ")
						upstreamData["address_raw"] = addrObj
						upstreamData["address"] = addrStr
					} else if s, ok := upstreamData["address"].(string); ok {
						addrStr = s
					}

					// Izgūstam platību un statusu
					var areaM2 float64
					if pMap, ok := upstreamData["parcel"].(map[string]any); ok {
						if aStr, ok := pMap["area"].(string); ok {
							areaM2, _ = strconv.ParseFloat(aStr, 64)
						}
						if sName, ok := pMap["status_name"].(string); ok && sName != "" {
							upstreamData["status"] = sName
						}
					}
					upstreamData["area_m2"] = areaM2

					// Izgūstam kadastrālo vērtību (fiskālā vai pirmā pieejamā)
					var cadVal float64
					if valList, ok := upstreamData["parcel_valuations"].([]any); ok {
						for _, vItem := range valList {
							if vMap, ok := vItem.(map[string]any); ok {
								if vMap["value_type"] == "fisc" {
									if valStr, ok := vMap["value"].(string); ok {
										cadVal, _ = strconv.ParseFloat(valStr, 64)
									}
									break
								}
							}
						}
						if cadVal == 0 && len(valList) > 0 {
							if vMap, ok := valList[0].(map[string]any); ok {
								if valStr, ok := vMap["value"].(string); ok {
									cadVal, _ = strconv.ParseFloat(valStr, 64)
								}
							}
						}
					}
					upstreamData["cadastral_value"] = cadVal

					// Pievienojam BVKB energoefektivitātes un VVD piesārņojuma datus
					cert, pollutionList := getParcelLocalEnrichment(r.Context(), code)
					upstreamData["energy_cert"] = cert
					upstreamData["pollution_nearby"] = pollutionList
					upstreamData["code"] = code

					writeJSON(w, http.StatusOK, upstreamData)
					return
				}
			}
		}
	}

	// 2. Lokālais PostGIS vaicājums kā drošs fallback
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	query := `
		SELECT code, COALESCE(address, ''), COALESCE(area_m2, 0), COALESCE(status, ''), COALESCE(cadastral_value, 0)
		FROM public.parcels
		WHERE code = $1
		LIMIT 1;
	`

	var pCode, address, status string
	var areaM2, cadValue float64

	err = dbPool.QueryRow(ctx, query, code).Scan(&pCode, &address, &areaM2, &status, &cadValue)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("Zemes vienība ar kodu '%s' netika atrasta", code),
		})
		return
	}

	// Ja adrese vēl nav piesaistīta, veicam ātru telpisko vaicājumu no adrešu reģistra
	if address == "" {
		_ = dbPool.QueryRow(ctx, `
			SELECT a.address
			FROM public.parcels p
			JOIN public.addresses a ON p.geom && a.geom AND ST_Contains(p.geom, a.geom)
			WHERE p.code = $1
			LIMIT 1;
		`, code).Scan(&address)
	}

	// Meklējam arī ēkas no lokālās DB
	type LocalBuilding struct {
		CadastreNr string  `json:"cadastre_nr"`
		Floors     int     `json:"ground_floors"`
		Year       int     `json:"exploit_year"`
		Material   string  `json:"material,omitempty"`
	}
	buildingsList := make([]LocalBuilding, 0)
	bRows, bErr := dbPool.Query(ctx, `
		SELECT code, COALESCE(floors, 1), COALESCE(construction_year, 0), COALESCE(material, '')
		FROM public.buildings
		WHERE parcel_code = $1
		ORDER BY code ASC
		LIMIT 20;
	`, code)
	if bErr == nil {
		defer bRows.Close()
		for bRows.Next() {
			var b LocalBuilding
			if err := bRows.Scan(&b.CadastreNr, &b.Floors, &b.Year, &b.Material); err == nil {
				buildingsList = append(buildingsList, b)
			}
		}
	}

	cert, pollutionList := getParcelLocalEnrichment(ctx, code)

	writeJSON(w, http.StatusOK, map[string]any{
		"code":             pCode,
		"address":          address,
		"area_m2":          areaM2,
		"status":           status,
		"cadastral_value":  cadValue,
		"buildings":        buildingsList,
		"energy_cert":      cert,
		"pollution_nearby": pollutionList,
	})
}

// /api/building-info?code=01001230055001
func handleBuildingInfo(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Parametrs 'code' ir obligāts"})
		return
	}

	// 1. Mēģinām iegūt no kadastrakarte.lv ar 3s noildzi
	client := &http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequestWithContext(r.Context(), "GET", "https://kadastrakarte.lv/api/building-info.php?code="+url.QueryEscape(code), nil)
	if err == nil {
		req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
		req.Header.Set("Referer", "https://kadastrakarte.lv/")
		resp, dErr := client.Do(req)
		if dErr == nil && resp.StatusCode == http.StatusOK {
			defer resp.Body.Close()
			body, rErr := io.ReadAll(resp.Body)
			if rErr == nil && len(body) > 20 && strings.Contains(string(body), `"building"`) {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(body)
				return
			}
		}
	}

	// 2. Lokālais PostGIS vaicājums kā drošs fallback
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var parcelCode, material string
	var floors, constrYear, deprPct int
	bErr := dbPool.QueryRow(ctx, `
		SELECT COALESCE(parcel_code, ''), COALESCE(floors, 1), COALESCE(construction_year, 0), COALESCE(depreciation_pct, 0), COALESCE(material, '')
		FROM public.buildings
		WHERE code = $1
		LIMIT 1;
	`, code).Scan(&parcelCode, &floors, &constrYear, &deprPct, &material)

	if bErr != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("Ēka ar kodu '%s' netika atrasta", code),
		})
		return
	}

	var address string
	var areaM2, cadValue float64
	if parcelCode != "" {
		_ = dbPool.QueryRow(ctx, `
			SELECT COALESCE(address, ''), COALESCE(area_m2, 0), COALESCE(cadastral_value, 0)
			FROM public.parcels
			WHERE code = $1
			LIMIT 1;
		`, parcelCode).Scan(&address, &areaM2, &cadValue)
	}

	if address == "" && parcelCode != "" {
		_ = dbPool.QueryRow(ctx, `
			SELECT a.address
			FROM public.parcels p
			JOIN public.addresses a ON p.geom && a.geom AND ST_Contains(p.geom, a.geom)
			WHERE p.code = $1
			LIMIT 1;
		`, parcelCode).Scan(&address)
	}

	parts := strings.Split(address, ",")
	streetHouse := strings.TrimSpace(parts[0])
	town := "Rīga"
	if len(parts) > 1 {
		town = strings.TrimSpace(parts[1])
	}
	shParts := strings.Fields(streetHouse)
	house := ""
	street := streetHouse
	if len(shParts) > 1 {
		house = shParts[len(shParts)-1]
		street = strings.Join(shParts[:len(shParts)-1], " ")
	}

	valStr := fmt.Sprintf("%.2f", cadValue)
	out := map[string]any{
		"building": map[string]any{
			"cadastre_nr":   code,
			"name":          "Dzīvojamā ēka",
			"use_kind_name": "Viena dzīvokļa mājas",
			"area":          "100.00",
			"ground_floors": floors,
			"exploit_year":  constrYear,
		},
		"address": map[string]any{
			"street": street,
			"house":  house,
			"town":   town,
		},
		"valuations": []map[string]any{
			{
				"value_type": "fisc",
				"value":      valStr,
			},
		},
		"premises_summary": map[string]any{
			"count": 1,
		},
		"ownership": map[string]any{
			"person_status": "fiziska persona",
		},
		"parcel_code": parcelCode,
	}

	writeJSON(w, http.StatusOK, out)
}

// /api/address-suggest?q=Doma
func handleAddressSuggest(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if len(q) < 2 {
		writeJSON(w, http.StatusOK, []any{})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	// Ātrā adrešu meklēšana ar telpisko zemes vienības piesaisti
	query := `
		SELECT 
			COALESCE(p.code, a.code, ''), 
			a.address,
			COALESCE(ST_X(ST_Transform(a.geom, 4326)), 0),
			COALESCE(ST_Y(ST_Transform(a.geom, 4326)), 0)
		FROM public.addresses a
		LEFT JOIN LATERAL (
			SELECT code FROM public.parcels p WHERE ST_Intersects(p.geom, a.geom) LIMIT 1
		) p ON true
		WHERE lv_normalize(a.address) ILIKE '%' || replace(lv_normalize($1), ' ', '%') || '%'
		LIMIT 10;
	`

	rows, err := dbPool.Query(ctx, query, q)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	type Suggestion struct {
		Code    string  `json:"code"`
		Address string  `json:"address"`
		Lng     float64 `json:"lng,omitempty"`
		Lat     float64 `json:"lat,omitempty"`
	}

	var results []Suggestion
	for rows.Next() {
		var s Suggestion
		if err := rows.Scan(&s.Code, &s.Address, &s.Lng, &s.Lat); err == nil {
			results = append(results, s)
		}
	}

	if results == nil {
		results = []Suggestion{}
	}

	writeJSON(w, http.StatusOK, results)
}

type Deal struct {
	DealID       int64     `json:"deal_id"`
	CadastreCode string    `json:"cadastre_code"`
	DealDate     time.Time `json:"deal_date"`
	AmountEur    float64   `json:"amount_eur"`
	AreaM2       float64   `json:"area_m2"`
	PricePerM2   float64   `json:"price_per_m2"`
	PropertyType string    `json:"property_type"`
	Address      string    `json:"address"`
}

// /api/transactions?cadastre=01000070001
func handleTransactions(w http.ResponseWriter, r *http.Request) {
	cad := r.URL.Query().Get("cadastre")
	if cad == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Parametrs 'cadastre' ir obligāts"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	query := `
		SELECT deal_id, cadastre_code, deal_date, amount_eur, COALESCE(area_m2, 0), COALESCE(price_per_m2, 0), property_type, COALESCE(address, '')
		FROM public.transactions
		WHERE cadastre_code = $1
		ORDER BY deal_date DESC
		LIMIT 50;
	`

	rows, err := dbPool.Query(ctx, query, cad)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	var deals []Deal
	for rows.Next() {
		var d Deal
		if err := rows.Scan(&d.DealID, &d.CadastreCode, &d.DealDate, &d.AmountEur, &d.AreaM2, &d.PricePerM2, &d.PropertyType, &d.Address); err == nil {
			deals = append(deals, d)
		}
	}

	if deals == nil {
		deals = []Deal{}
	}

	writeJSON(w, http.StatusOK, deals)
}

// /api/listings vai /api/listings-geojson?portal=ss.com&bbox=20.9,55.6,28.3,58.1
func handleListingsGeoJSON(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()

	bboxStr := r.URL.Query().Get("bbox")
	portal := r.URL.Query().Get("portal")
	if portal == "" {
		portal = r.URL.Query().Get("source")
	}
	dealType := r.URL.Query().Get("deal_type")
	category := r.URL.Query().Get("category")

	whereClauses := []string{"l.is_active = TRUE", "l.geom IS NOT NULL"}
	args := []any{}
	argIdx := 1

	if bboxStr != "" {
		coords := strings.Split(bboxStr, ",")
		if len(coords) == 4 {
			minX, _ := strconv.ParseFloat(strings.TrimSpace(coords[0]), 64)
			minY, _ := strconv.ParseFloat(strings.TrimSpace(coords[1]), 64)
			maxX, _ := strconv.ParseFloat(strings.TrimSpace(coords[2]), 64)
			maxY, _ := strconv.ParseFloat(strings.TrimSpace(coords[3]), 64)
			whereClauses = append(whereClauses, fmt.Sprintf("l.geom && ST_MakeEnvelope($%d, $%d, $%d, $%d, 4326)", argIdx, argIdx+1, argIdx+2, argIdx+3))
			args = append(args, minX, minY, maxX, maxY)
			argIdx += 4
		}
	}

	if portal != "" && portal != "all" {
		whereClauses = append(whereClauses, fmt.Sprintf("l.source = $%d", argIdx))
		args = append(args, portal)
		argIdx++
	}

	if dealType != "" {
		whereClauses = append(whereClauses, fmt.Sprintf("l.deal_type = $%d", argIdx))
		args = append(args, dealType)
		argIdx++
	}

	if category != "" {
		whereClauses = append(whereClauses, fmt.Sprintf("l.category = $%d", argIdx))
		args = append(args, category)
		argIdx++
	}

	limitStr := r.URL.Query().Get("limit")
	limit := 20000
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 30000 {
			limit = l
		}
	}

	query := fmt.Sprintf(`
		SELECT 
			l.id, l.source, l.external_id, l.deal_type, l.category, 
			COALESCE(l.title, ''), COALESCE(l.url, ''), COALESCE(l.price, 0), 
			COALESCE(l.first_price, l.price, 0), COALESCE(l.price_per_m2, 0), 
			COALESCE(l.area_m2, 0), COALESCE(l.rooms, 0), COALESCE(l.floor, 0), 
			COALESCE(l.total_floors, 0), COALESCE(l.series, ''), COALESCE(l.address_text, ''), 
			COALESCE(l.town, ''), COALESCE(l.district, ''), l.images, 
			l.days_on_market, COALESCE(l.cadastre_code, ''),
			ST_X(l.geom), ST_Y(l.geom)
		FROM public.listings l
		WHERE %s
		ORDER BY l.id DESC
		LIMIT %d;
	`, strings.Join(whereClauses, " AND "), limit)

	rows, err := dbPool.Query(ctx, query, args...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	type GeoFeature struct {
		Type       string         `json:"type"`
		ID         int64          `json:"id"`
		Geometry   map[string]any `json:"geometry"`
		Properties map[string]any `json:"properties"`
	}

	features := make([]GeoFeature, 0)
	for rows.Next() {
		var id int64
		var source, extID, dType, cat, title, u, series, addr, town, dist, cadCode string
		var price, firstPrice, ppm2, area float64
		var rooms, floor, totFloors, days int
		var imagesRaw []byte
		var lng, lat float64

		if err := rows.Scan(
			&id, &source, &extID, &dType, &cat,
			&title, &u, &price,
			&firstPrice, &ppm2,
			&area, &rooms, &floor,
			&totFloors, &series, &addr,
			&town, &dist, &imagesRaw,
			&days, &cadCode,
			&lng, &lat,
		); err == nil {
			var images []string
			if len(imagesRaw) > 0 {
				_ = json.Unmarshal(imagesRaw, &images)
			}
			thumb := ""
			if source != "" && extID != "" {
				thumb = fmt.Sprintf("/listings/thumbs/%s_%s.webp", source, extID)
			} else if len(images) > 0 {
				thumb = images[0]
			}

			floorStr := ""
			if floor > 0 {
				if totFloors > 0 {
					floorStr = fmt.Sprintf("%d/%d", floor, totFloors)
				} else {
					floorStr = fmt.Sprintf("%d", floor)
				}
			}

			hasDrop := firstPrice > price && price > 0

			feat := GeoFeature{
				Type: "Feature",
				ID:   id,
				Geometry: map[string]any{
					"type":        "Point",
					"coordinates": []float64{lng, lat},
				},
				Properties: map[string]any{
					"id":             id,
					"mid":            extID,
					"portal":         source,
					"category":       cat,
					"deal_type":      dType,
					"snippet":        title,
					"url":            u,
					"price":          price,
					"first_price":    firstPrice,
					"price_per_m2":   ppm2,
					"rooms":          rooms,
					"area":           area,
					"floor":          floorStr,
					"series":         series,
					"addr":           addr,
					"town":           town,
					"district":       dist,
					"thumb":          thumb,
					"images":         images,
					"drop":           hasDrop,
					"days":           days,
					"days_on_market": days,
					"cadastre_code":  cadCode,
				},
			}
			features = append(features, feat)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"type":     "FeatureCollection",
		"count":    len(features),
		"features": features,
	})
}

// /api/listing-history?mid=55565983&portal=ss.com vai ?id=1365
func handleListingHistory(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	mid := r.URL.Query().Get("mid")
	portal := r.URL.Query().Get("portal")
	if portal == "" {
		portal = r.URL.Query().Get("source")
	}
	if portal == "" {
		portal = "ss.com"
	}
	idStr := r.URL.Query().Get("id")

	var id int64
	var source, extID, dType, u, sinceDate, addr, town string
	var price, firstPrice, area float64
	var days, rooms, floor int
	var imagesRaw []byte

	var err error
	if idStr != "" {
		idVal, _ := strconv.ParseInt(idStr, 10, 64)
		err = dbPool.QueryRow(ctx, `
			SELECT 
				l.id, l.source, l.external_id, l.deal_type, l.url, 
				COALESCE(l.price, 0), COALESCE(l.first_price, l.price, 0), 
				l.days_on_market, COALESCE(to_char(l.published_at, 'YYYY-MM-DD'), ''),
				l.images, COALESCE(l.area_m2, 0), COALESCE(l.rooms, 0), 
				COALESCE(l.floor, 0), COALESCE(l.address_text, ''), COALESCE(l.town, '')
			FROM public.listings l
			WHERE l.id = $1
			LIMIT 1;
		`, idVal).Scan(
			&id, &source, &extID, &dType, &u,
			&price, &firstPrice, &days, &sinceDate,
			&imagesRaw, &area, &rooms, &floor, &addr, &town,
		)
	} else if mid != "" {
		err = dbPool.QueryRow(ctx, `
			SELECT 
				l.id, l.source, l.external_id, l.deal_type, l.url, 
				COALESCE(l.price, 0), COALESCE(l.first_price, l.price, 0), 
				l.days_on_market, COALESCE(to_char(l.published_at, 'YYYY-MM-DD'), ''),
				l.images, COALESCE(l.area_m2, 0), COALESCE(l.rooms, 0), 
				COALESCE(l.floor, 0), COALESCE(l.address_text, ''), COALESCE(l.town, '')
			FROM public.listings l
			WHERE l.source = $1 AND l.external_id = $2
			LIMIT 1;
		`, portal, mid).Scan(
			&id, &source, &extID, &dType, &u,
			&price, &firstPrice, &days, &sinceDate,
			&imagesRaw, &area, &rooms, &floor, &addr, &town,
		)
	} else {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "why": "missing_parameters"})
		return
	}

	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "has": false, "why": "not_found"})
		return
	}

	var images []string
	if len(imagesRaw) > 0 {
		_ = json.Unmarshal(imagesRaw, &images)
	}

	type PriceChangeItem struct {
		Date  string   `json:"date"`
		Delta *float64 `json:"delta"`
		Price float64  `json:"price"`
	}

	changes := make([]PriceChangeItem, 0)
	cRows, cErr := dbPool.Query(ctx, `
		SELECT to_char(change_date, 'YYYY-MM-DD'), old_price, new_price, delta_amount
		FROM public.listing_price_changes
		WHERE listing_id = $1
		ORDER BY change_date ASC;
	`, id)

	dropsCount := 0
	if cErr == nil {
		defer cRows.Close()
		var firstFound bool
		for cRows.Next() {
			var chDate string
			var oldP, newP, deltaAmt float64
			if err := cRows.Scan(&chDate, &oldP, &newP, &deltaAmt); err == nil {
				if !firstFound {
					changes = append(changes, PriceChangeItem{
						Date:  chDate,
						Delta: nil,
						Price: oldP,
					})
					firstFound = true
				}
				changes = append(changes, PriceChangeItem{
					Date:  chDate,
					Delta: &deltaAmt,
					Price: newP,
				})
				if deltaAmt < 0 {
					dropsCount++
				}
			}
		}
	}

	if len(changes) == 0 && firstPrice > price && price > 0 {
		changes = append(changes, PriceChangeItem{
			Date:  sinceDate,
			Delta: nil,
			Price: firstPrice,
		})
		deltaAmt := price - firstPrice
		changes = append(changes, PriceChangeItem{
			Date:  time.Now().Format("2006-01-02"),
			Delta: &deltaAmt,
			Price: price,
		})
		dropsCount = 1
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"has":         true,
		"portal":      source,
		"mid":         extID,
		"url":         u,
		"deal_type":   dType,
		"days":        days,
		"since":       sinceDate,
		"first_price": firstPrice,
		"last_price":  price,
		"changes":     changes,
		"drops":       dropsCount,
		"images":      images,
		"meta": map[string]any{
			"area":   area,
			"rooms":  rooms,
			"floor":  floor,
			"town":   town,
			"street": addr,
		},
	})
}

// /api/popup-signals?code=36010086601&lat=57.42&lon=27.04
func handlePopupSignals(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	latStr := r.URL.Query().Get("lat")
	lonStr := r.URL.Query().Get("lon")
	if lonStr == "" {
		lonStr = r.URL.Query().Get("lng")
	}

	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()

	if code == "" && latStr != "" && lonStr != "" {
		lat, _ := strconv.ParseFloat(latStr, 64)
		lon, _ := strconv.ParseFloat(lonStr, 64)
		_ = dbPool.QueryRow(ctx, `
			SELECT code FROM public.parcels
			WHERE ST_Contains(geom, ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3857))
			LIMIT 1;
		`, lon, lat).Scan(&code)
	}

	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Parametrs 'code' vai koordinātas ir obligātas"})
		return
	}

	// Mēģinām iegūt tiešos signālus no kadastrakarte.lv
	upReq, uErr := http.NewRequestWithContext(r.Context(), "GET", "https://kadastrakarte.lv/api/popup-signals.php?"+r.URL.RawQuery, nil)
	if uErr == nil {
		upReq.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
		upReq.Header.Set("Referer", "https://kadastrakarte.lv/")
		uClient := &http.Client{Timeout: 2500 * time.Millisecond}
		uResp, dErr := uClient.Do(upReq)
		if dErr == nil && uResp.StatusCode == http.StatusOK {
			defer uResp.Body.Close()
			b, rErr := io.ReadAll(uResp.Body)
			if rErr == nil && len(b) > 10 && strings.Contains(string(b), `"signals"`) {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(b)
				return
			}
		}
	}

	type Signal struct {
		Key    string `json:"key"`
		Level  string `json:"level"`
		Title  string `json:"title"`
		Sub    string `json:"sub,omitempty"`
		Tip    string `json:"tip,omitempty"`
		N      int    `json:"n,omitempty"`
		Median any    `json:"median,omitempty"`
		Scope  any    `json:"scope,omitempty"`
		Last   any    `json:"last,omitempty"`
	}

	signals := make([]Signal, 0)
	hasRisks := false

	// 1. Darījumi šajā zemē (tx)
	type TxLastItem struct {
		D    string  `json:"d"`
		DT   string  `json:"dt"`
		S    float64 `json:"s"`
		A    float64 `json:"a"`
		Ppm2 float64 `json:"ppm2,omitempty"`
	}
	lastDeals := make([]TxLastItem, 0)
	var txCount int
	var txMedian float64

	tErr := dbPool.QueryRow(ctx, `
		SELECT COUNT(*), COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY amount_eur), 0)
		FROM public.transactions
		WHERE cadastre_code = $1;
	`, code).Scan(&txCount, &txMedian)

	if tErr == nil && txCount > 0 {
		dRows, _ := dbPool.Query(ctx, `
			SELECT to_char(deal_date, 'MM.YYYY'), to_char(deal_date, 'YYYY-MM-DD'), amount_eur, COALESCE(area_m2, 0), COALESCE(price_per_m2, 0)
			FROM public.transactions
			WHERE cadastre_code = $1
			ORDER BY deal_date DESC
			LIMIT 5;
		`, code)
		if dRows != nil {
			defer dRows.Close()
			for dRows.Next() {
				var d, dt string
				var s, a, p float64
				if err := dRows.Scan(&d, &dt, &s, &a, &p); err == nil {
					lastDeals = append(lastDeals, TxLastItem{D: d, DT: dt, S: s, A: a, Ppm2: p})
				}
			}
		}

		lastSub := ""
		if len(lastDeals) > 0 {
			lastSub = "pēdējais " + lastDeals[0].D
		}

		signals = append(signals, Signal{
			Key:    "tx",
			Level:  "info",
			Title:  fmt.Sprintf("%d darījumi šajā zemē", txCount),
			Sub:    lastSub,
			N:      txCount,
			Median: txMedian,
			Last:   lastDeals,
		})
	}

	// 2. Darījumi 500m rādiusā (tx_near)
	var nearCount int
	var nearMedian float64
	var nearLastDate string
	nErr := dbPool.QueryRow(ctx, `
		SELECT COUNT(*), COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.amount_eur), 0), COALESCE(to_char(MAX(t.deal_date), 'MM.YYYY'), '')
		FROM public.transactions t, public.parcels p
		WHERE p.code = $1 AND p.geom IS NOT NULL AND t.geom IS NOT NULL
		  AND ST_DWithin(p.geom, t.geom, 500)
		  AND (t.cadastre_code IS NULL OR t.cadastre_code != $1);
	`, code).Scan(&nearCount, &nearMedian, &nearLastDate)

	if nErr == nil && nearCount > 0 {
		subStr := fmt.Sprintf("mediāna %d €", int(nearMedian))
		if nearLastDate != "" {
			subStr += " · pēdējais " + nearLastDate
		}
		signals = append(signals, Signal{
			Key:    "tx_near",
			Level:  "info",
			Title:  fmt.Sprintf("%d darījumi 500 m rādiusā", nearCount),
			Sub:    subStr,
			N:      nearCount,
			Median: nearMedian,
			Scope:  500,
		})
	}

	// 3. Apgrūtinājumi un servitūti (enc)
	var encCount int
	var encTypes string
	eErr := dbPool.QueryRow(ctx, `
		SELECT COUNT(*), COALESCE(string_agg(DISTINCT w.restriction_type, '; '), '')
		FROM public.way_restrictions w, public.parcels p
		WHERE p.code = $1 AND p.geom IS NOT NULL AND ST_Intersects(p.geom, w.geom);
	`, code).Scan(&encCount, &encTypes)

	if eErr == nil && encCount > 0 {
		signals = append(signals, Signal{
			Key:   "enc",
			Level: "info",
			Title: fmt.Sprintf("%d apgrūtinājumi", encCount),
			Sub:   "Valsts nozīmes aizsargjoslas un servitūti",
			Tip:   encTypes,
		})
	}

	// 4. Teritorijas plānotais zonējums (zone)
	var zIndekss, zNosaukums string
	zErr := dbPool.QueryRow(ctx, `
		SELECT COALESCE(t.indekss, ''), COALESCE(t.nosaukums, '')
		FROM public.tapis_zonejums t, public.parcels p
		WHERE p.code = $1 AND p.geom IS NOT NULL AND ST_Intersects(p.geom, t.geom)
		LIMIT 1;
	`, code).Scan(&zIndekss, &zNosaukums)

	if zErr == nil && zIndekss != "" {
		signals = append(signals, Signal{
			Key:   "zone",
			Level: "info",
			Title: "Zonējums " + zIndekss,
			Sub:   zNosaukums,
		})
	}

	// 5. Vides un drošības riski (plūdi, grausti, dabas liegumi)
	var hasFlood, hasNature, hasDegrading bool
	_ = dbPool.QueryRow(ctx, `
		SELECT 
			EXISTS(SELECT 1 FROM public.flood_zone_spring_100y f, public.parcels p WHERE p.code = $1 AND p.geom IS NOT NULL AND ST_Intersects(p.geom, f.geom)) OR
			EXISTS(SELECT 1 FROM public.flood_zone_sea_100y f, public.parcels p WHERE p.code = $1 AND p.geom IS NOT NULL AND ST_Intersects(p.geom, f.geom)),
			EXISTS(SELECT 1 FROM public.mv_protected_areas a, public.parcels p WHERE p.code = $1 AND p.geom IS NOT NULL AND ST_Intersects(p.geom, a.geom)),
			EXISTS(SELECT 1 FROM public.degrading_buildings d WHERE d.cadastre_code = $1);
	`, code).Scan(&hasFlood, &hasNature, &hasDegrading)

	if hasFlood {
		hasRisks = true
		signals = append(signals, Signal{
			Key:   "flood",
			Level: "warn",
			Title: "Plūdu riska zona",
			Sub:   "LVĢMC 100 gadu plūdu draudi",
		})
	}

	if hasNature {
		signals = append(signals, Signal{
			Key:   "nature",
			Level: "info",
			Title: "Aizsargājama dabas teritorija",
			Sub:   "DAP ĪADT vai mikroliegums",
		})
	}

	if hasDegrading {
		hasRisks = true
		signals = append(signals, Signal{
			Key:   "degrading",
			Level: "warn",
			Title: "Vidi degradējoša būve",
			Sub:   "Reģistrēts grausts",
		})
	}

	if !hasRisks && len(signals) == 0 {
		signals = append(signals, Signal{
			Key:   "ok",
			Level: "good",
			Title: "Bez zināmiem riskiem",
			Sub:   "troksnis, plūdi, piesārņojums, liegumi",
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"signals": signals,
		"risk":    hasRisks,
		"sources": 11,
	})
}

var (
	auctionsCacheMu   sync.RWMutex
	auctionsCacheData []byte
	auctionsCacheTime time.Time
)

func handleAuctions(w http.ResponseWriter, r *http.Request) {
	auctionsCacheMu.RLock()
	if len(auctionsCacheData) > 0 && time.Since(auctionsCacheTime) < 10*time.Minute {
		data := auctionsCacheData
		auctionsCacheMu.RUnlock()
		w.Header().Set("Content-Type", "application/json")
		w.Write(data)
		return
	}
	auctionsCacheMu.RUnlock()

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get("https://kadastrakarte.lv/api/auctions-geojson.php?bbox=20.9,55.6,28.3,58.1")
	if err != nil {
		auctionsCacheMu.RLock()
		if len(auctionsCacheData) > 0 {
			data := auctionsCacheData
			auctionsCacheMu.RUnlock()
			w.Header().Set("Content-Type", "application/json")
			w.Write(data)
			return
		}
		auctionsCacheMu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{"type": "FeatureCollection", "count": 0, "features": []any{}})
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"type": "FeatureCollection", "count": 0, "features": []any{}})
		return
	}

	auctionsCacheMu.Lock()
	auctionsCacheData = body
	auctionsCacheTime = time.Now()
	auctionsCacheMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.Write(body)
}

// /api/scraper-status - Atgriež skreiperu veselības statusu un pēdējo izpildes žurnālu
func handleScraperStatus(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if dbPool == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "error",
			"error":  "Datubāze nav pieejama",
		})
		return
	}

	type ScraperRunRow struct {
		ID           int64      `json:"id"`
		Source       string     `json:"source"`
		Mode         string     `json:"mode"`
		Status       string     `json:"status"`
		StartedAt    time.Time  `json:"started_at"`
		FinishedAt   *time.Time `json:"finished_at,omitempty"`
		DurationSec  *float64   `json:"duration_sec,omitempty"`
		ItemsScraped int        `json:"items_scraped"`
		ItemsSaved   int        `json:"items_saved"`
		ItemsNew     int        `json:"items_new"`
		ItemsUpdated int        `json:"items_updated"`
		PriceChanges int        `json:"price_changes"`
		ErrorsCount  int        `json:"errors_count"`
		ErrorMessage *string    `json:"error_message,omitempty"`
		MinutesAgo   int        `json:"minutes_ago"`
	}

	runs := make([]ScraperRunRow, 0)
	rows, err := dbPool.Query(ctx, `
		SELECT id, source, mode, status, started_at, finished_at, duration_sec,
		       items_scraped, items_saved, items_new, items_updated, price_changes,
		       errors_count, error_message,
		       ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at))/60)::int as minutes_ago
		FROM public.scraper_runs
		ORDER BY started_at DESC
		LIMIT 20;
	`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var row ScraperRunRow
			if err := rows.Scan(
				&row.ID, &row.Source, &row.Mode, &row.Status, &row.StartedAt, &row.FinishedAt, &row.DurationSec,
				&row.ItemsScraped, &row.ItemsSaved, &row.ItemsNew, &row.ItemsUpdated, &row.PriceChanges,
				&row.ErrorsCount, &row.ErrorMessage, &row.MinutesAgo,
			); err == nil {
				runs = append(runs, row)
			}
		}
	}

	// Kopējie skaitļi
	var totalListings, activeListings, totalPriceChanges int64
	_ = dbPool.QueryRow(ctx, "SELECT count(*) FROM public.listings").Scan(&totalListings)
	_ = dbPool.QueryRow(ctx, "SELECT count(*) FROM public.listings WHERE is_active = true").Scan(&activeListings)
	_ = dbPool.QueryRow(ctx, "SELECT count(*) FROM public.listing_price_changes").Scan(&totalPriceChanges)

	isHealthy := true
	healthMsg := "Skreiperu dzinējs darbojas normāli"

	if len(runs) == 0 {
		isHealthy = false
		healthMsg = "Nav fiksēts neviens skreipera cikls"
	} else {
		lastRun := runs[0]
		if lastRun.Status == "failed" {
			isHealthy = false
			healthMsg = "Pēdējais skreipera cikls beidzās ar kļūdu"
		} else if lastRun.MinutesAgo > 180 { // ilgāk par 3 stundām
			isHealthy = false
			healthMsg = fmt.Sprintf("Brīdinājums: Pēdējais skreipera cikls bija pirms %d minūtēm (> 3h)", lastRun.MinutesAgo)
		}
	}

	var lastRun any = nil
	if len(runs) > 0 {
		lastRun = runs[0]
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"is_healthy": isHealthy,
		"status":     healthMsg,
		"last_run":   lastRun,
		"totals": map[string]any{
			"total_listings":      totalListings,
			"active_listings":     activeListings,
			"total_price_changes": totalPriceChanges,
		},
		"runs": runs,
	})
}

var (
	txPtsCacheMutex sync.RWMutex
	txPtsCacheBytes []byte
	txPtsCacheTime  time.Time
)

// handleTxPts atgriež visus PostGIS darījumu punktus delta-kodētā masīvā klasterēšanai pie Z < 14
func handleTxPts(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")

	txPtsCacheMutex.RLock()
	if len(txPtsCacheBytes) > 0 && time.Since(txPtsCacheTime) < 30*time.Minute {
		cached := txPtsCacheBytes
		txPtsCacheMutex.RUnlock()
		w.Write(cached)
		return
	}
	txPtsCacheMutex.RUnlock()

	if dbPool == nil {
		http.Error(w, `{"error":"Datubāze nav pieejama"}`, http.StatusServiceUnavailable)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()

	rows, err := dbPool.Query(ctx, `
		SELECT 
			round(ST_X(ST_Transform(geom, 4326))::numeric * 10000)::integer AS x,
			round(ST_Y(ST_Transform(geom, 4326))::numeric * 10000)::integer AS y,
			CASE 
				WHEN property_type ILIKE '%būve%' THEN 1
				WHEN property_type ILIKE '%zeme%' THEN 2
				WHEN property_type = 'zv' THEN 2
				ELSE 0
			END AS ptype
		FROM public.transactions
		WHERE geom IS NOT NULL
		ORDER BY y ASC, x ASC;
	`)
	if err != nil {
		log.Printf("Kļūda atlasot darījumu punktus: %v", err)
		http.Error(w, `{"error":"Kļūda atlasot datus"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var flat []int32
	var prevX, prevY int32

	for rows.Next() {
		var x, y, ptype int32
		if err := rows.Scan(&x, &y, &ptype); err == nil {
			dx := x - prevX
			dy := y - prevY
			flat = append(flat, dx, dy, ptype)
			prevX = x
			prevY = y
		}
	}

	bytes, err := json.Marshal(flat)
	if err != nil {
		http.Error(w, `{"error":"Kļūda kodējot datus"}`, http.StatusInternalServerError)
		return
	}

	txPtsCacheMutex.Lock()
	txPtsCacheBytes = bytes
	txPtsCacheTime = time.Now()
	txPtsCacheMutex.Unlock()

	w.Write(bytes)
}

var (
	mekletStatsCacheMutex sync.RWMutex
	mekletStatsCacheBytes []byte
	mekletStatsCacheTime  time.Time
)

// handleMekletStats atgriež dzīvos kopskaitus 4 galvenajām kategorijām
func handleMekletStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=120")

	mekletStatsCacheMutex.RLock()
	if len(mekletStatsCacheBytes) > 0 && time.Since(mekletStatsCacheTime) < 3*time.Minute {
		cached := mekletStatsCacheBytes
		mekletStatsCacheMutex.RUnlock()
		w.Write(cached)
		return
	}
	mekletStatsCacheMutex.RUnlock()

	if dbPool == nil {
		http.Error(w, `{"error":"Datubāze nav pieejama"}`, http.StatusServiceUnavailable)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var listingsCount, dealsCount, parcelsCount, buildingsCount, auctionsCount int64

	_ = dbPool.QueryRow(ctx, "SELECT count(*) FROM public.listings WHERE is_active = true").Scan(&listingsCount)
	_ = dbPool.QueryRow(ctx, "SELECT count(*) FROM public.transactions").Scan(&dealsCount)
	_ = dbPool.QueryRow(ctx, "SELECT count(*) FROM public.parcels").Scan(&parcelsCount)
	_ = dbPool.QueryRow(ctx, "SELECT count(*) FROM public.buildings").Scan(&buildingsCount)
	_ = dbPool.QueryRow(ctx, "SELECT count(*) FROM public.listings WHERE is_active = true AND (deal_type = 'auction' OR category = 'auctions')").Scan(&auctionsCount)

	res := map[string]any{
		"listings":   listingsCount,
		"deals":      dealsCount,
		"props":      parcelsCount + buildingsCount,
		"auctions":   auctionsCount,
		"updated_at": time.Now().Format(time.RFC3339),
	}

	bytes, err := json.Marshal(res)
	if err == nil {
		mekletStatsCacheMutex.Lock()
		mekletStatsCacheBytes = bytes
		mekletStatsCacheTime = time.Now()
		mekletStatsCacheMutex.Unlock()
	}

	w.Write(bytes)
}

// handleUnifiedSearch apstrādā vienoto /api/search pieprasījumu
func handleUnifiedSearch(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()

	if dbPool == nil {
		http.Error(w, `{"error":"Datubāze nav pieejama"}`, http.StatusServiceUnavailable)
		return
	}

	qParams := r.URL.Query()
	mode := strings.ToLower(strings.TrimSpace(qParams.Get("mode")))
	if mode == "" {
		mode = "listings"
	}

	page, _ := strconv.Atoi(qParams.Get("page"))
	if page < 1 {
		page = 1
	}
	per, _ := strconv.Atoi(qParams.Get("per"))
	if per < 1 || per > 100 {
		per = 50
	}
	offset := (page - 1) * per

	q := strings.TrimSpace(qParams.Get("q"))
	bboxStr := strings.TrimSpace(qParams.Get("bbox"))

	switch mode {
	case "deals":
		searchDeals(w, ctx, qParams, q, bboxStr, page, per, offset)
	case "props":
		searchProps(w, ctx, qParams, q, bboxStr, page, per, offset)
	case "auctions":
		searchAuctions(w, ctx, qParams, q, bboxStr, page, per, offset)
	default:
		searchListings(w, ctx, qParams, q, bboxStr, page, per, offset)
	}
}

func searchListings(w http.ResponseWriter, ctx context.Context, qParams url.Values, q, bboxStr string, page, per, offset int) {
	whereClauses := []string{"1=1"}
	args := []any{}
	argIdx := 1

	active := strings.ToLower(qParams.Get("active"))
	if active == "" || active == "1" || active == "true" {
		whereClauses = append(whereClauses, "l.is_active = TRUE")
	} else if active == "0" || active == "false" {
		whereClauses = append(whereClauses, "l.is_active = FALSE")
	}

	deal := strings.ToLower(qParams.Get("deal"))
	if deal == "" {
		deal = strings.ToLower(qParams.Get("deal_type"))
	}
	if deal != "" && deal != "all" {
		whereClauses = append(whereClauses, fmt.Sprintf("l.deal_type = $%d", argIdx))
		args = append(args, deal)
		argIdx++
	}

	cat := strings.ToLower(qParams.Get("cat"))
	if cat == "" {
		cat = strings.ToLower(qParams.Get("category"))
	}
	if cat != "" && cat != "all" {
		whereClauses = append(whereClauses, fmt.Sprintf("l.category = $%d", argIdx))
		args = append(args, cat)
		argIdx++
	}

	portal := strings.ToLower(qParams.Get("portal"))
	if portal == "" {
		portal = strings.ToLower(qParams.Get("source"))
	}
	if portal != "" && portal != "all" {
		whereClauses = append(whereClauses, fmt.Sprintf("l.source = $%d", argIdx))
		args = append(args, portal)
		argIdx++
	}

	town := strings.TrimSpace(qParams.Get("town"))
	if town != "" {
		whereClauses = append(whereClauses, fmt.Sprintf("(l.town ILIKE $%d OR l.district ILIKE $%d)", argIdx, argIdx))
		args = append(args, "%"+town+"%")
		argIdx++
	}

	district := strings.TrimSpace(qParams.Get("district"))
	if district != "" {
		whereClauses = append(whereClauses, fmt.Sprintf("l.district ILIKE $%d", argIdx))
		args = append(args, "%"+district+"%")
		argIdx++
	}

	series := strings.TrimSpace(qParams.Get("series"))
	if series != "" {
		whereClauses = append(whereClauses, fmt.Sprintf("l.series ILIKE $%d", argIdx))
		args = append(args, "%"+series+"%")
		argIdx++
	}

	if pminStr := qParams.Get("pmin"); pminStr != "" {
		if pmin, err := strconv.ParseFloat(pminStr, 64); err == nil && pmin > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("l.price >= $%d", argIdx))
			args = append(args, pmin)
			argIdx++
		}
	}
	if pmaxStr := qParams.Get("pmax"); pmaxStr != "" {
		if pmax, err := strconv.ParseFloat(pmaxStr, 64); err == nil && pmax > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("l.price <= $%d", argIdx))
			args = append(args, pmax)
			argIdx++
		}
	}

	if aminStr := qParams.Get("amin"); aminStr != "" {
		if amin, err := strconv.ParseFloat(aminStr, 64); err == nil && amin > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("l.area_m2 >= $%d", argIdx))
			args = append(args, amin)
			argIdx++
		}
	}
	if amaxStr := qParams.Get("amax"); amaxStr != "" {
		if amax, err := strconv.ParseFloat(amaxStr, 64); err == nil && amax > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("l.area_m2 <= $%d", argIdx))
			args = append(args, amax)
			argIdx++
		}
	}

	if rminStr := qParams.Get("rmin"); rminStr != "" {
		if rmin, err := strconv.Atoi(rminStr); err == nil && rmin > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("l.rooms >= $%d", argIdx))
			args = append(args, rmin)
			argIdx++
		}
	}
	if rmaxStr := qParams.Get("rmax"); rmaxStr != "" {
		if rmax, err := strconv.Atoi(rmaxStr); err == nil && rmax > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("l.rooms <= $%d", argIdx))
			args = append(args, rmax)
			argIdx++
		}
	}

	if drop := qParams.Get("drop"); drop == "1" || drop == "true" {
		whereClauses = append(whereClauses, "(l.first_price > 0 AND l.price < l.first_price)")
	}

	if q != "" {
		whereClauses = append(whereClauses, fmt.Sprintf("(l.address_text ILIKE $%d OR l.title ILIKE $%d OR l.cadastre_code = $%d)", argIdx, argIdx, argIdx))
		args = append(args, "%"+q+"%")
		argIdx++
	}

	if bboxStr != "" {
		coords := strings.Split(bboxStr, ",")
		if len(coords) == 4 {
			minX, _ := strconv.ParseFloat(strings.TrimSpace(coords[0]), 64)
			minY, _ := strconv.ParseFloat(strings.TrimSpace(coords[1]), 64)
			maxX, _ := strconv.ParseFloat(strings.TrimSpace(coords[2]), 64)
			maxY, _ := strconv.ParseFloat(strings.TrimSpace(coords[3]), 64)
			whereClauses = append(whereClauses, fmt.Sprintf("l.geom && ST_MakeEnvelope($%d, $%d, $%d, $%d, 4326)", argIdx, argIdx+1, argIdx+2, argIdx+3))
			args = append(args, minX, minY, maxX, maxY)
			argIdx += 4
		}
	}

	sortField := qParams.Get("sort")
	dir := strings.ToUpper(qParams.Get("dir"))
	if dir != "ASC" && dir != "DESC" {
		dir = "DESC"
	}

	orderBy := "l.last_seen_at DESC"
	switch sortField {
	case "date":
		orderBy = fmt.Sprintf("l.first_seen_at %s", dir)
	case "price", "price_asc", "price_desc":
		if sortField == "price_asc" {
			dir = "ASC"
		}
		orderBy = fmt.Sprintf("l.price %s NULLS LAST", dir)
	case "ppm", "price_per_m2":
		orderBy = fmt.Sprintf("l.price_per_m2 %s NULLS LAST", dir)
	case "area":
		orderBy = fmt.Sprintf("l.area_m2 %s NULLS LAST", dir)
	case "drop", "drop_pct":
		orderBy = "((l.first_price - l.price) / NULLIF(l.first_price, 0)) DESC NULLS LAST"
	default:
		orderBy = fmt.Sprintf("l.last_seen_at %s", dir)
	}

	query := fmt.Sprintf(`
		SELECT 
			l.id, l.source, l.external_id, l.deal_type, l.category, l.title, l.url,
			COALESCE(l.price, 0), COALESCE(l.first_price, 0), COALESCE(l.price_per_m2, 0),
			COALESCE(l.area_m2, 0), COALESCE(l.rooms, 0), COALESCE(l.floor, 0), COALESCE(l.total_floors, 0),
			COALESCE(l.series, ''), COALESCE(l.house_type, ''), COALESCE(l.address_text, ''),
			COALESCE(l.town, ''), COALESCE(l.district, ''), COALESCE(l.cadastre_code, ''),
			COALESCE(l.images::text, '[]'), l.days_on_market, l.is_active,
			to_char(l.published_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			to_char(l.first_seen_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			to_char(l.last_seen_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			to_char(l.closed_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			COALESCE(ST_X(l.geom), 0),
			COALESCE(ST_Y(l.geom), 0),
			CASE 
				WHEN l.first_price > 0 AND l.price < l.first_price 
				THEN round(((l.price - l.first_price) / l.first_price * 100)::numeric, 1)
				ELSE NULL 
			END AS drop_pct,
			count(*) OVER() AS full_count
		FROM public.listings l
		WHERE %s
		ORDER BY %s
		LIMIT $%d OFFSET $%d;
	`, strings.Join(whereClauses, " AND "), orderBy, argIdx, argIdx+1)

	args = append(args, per, offset)

	rows, err := dbPool.Query(ctx, query, args...)
	if err != nil {
		log.Printf("Kļūda meklējot sludinājumus: %v", err)
		writeJSON(w, http.StatusOK, map[string]any{
			"mode":  "listings",
			"total": 0,
			"page":  page,
			"per":   per,
			"rows":  []any{},
		})
		return
	}
	defer rows.Close()

	var totalCount int64 = 0
	type ListingRow struct {
		ID           int64    `json:"id"`
		Portal       string   `json:"portal"`
		Mid          string   `json:"mid"`
		DealType     string   `json:"deal_type"`
		Category     string   `json:"category"`
		Title        string   `json:"title"`
		URL          string   `json:"url"`
		Price        float64  `json:"price"`
		FirstPrice   float64  `json:"first_price"`
		PricePerM2   float64  `json:"price_per_m2"`
		Area         float64  `json:"area"`
		Rooms        int      `json:"rooms"`
		Floor        int      `json:"floor"`
		TotalFloors  int      `json:"total_floors"`
		Series       string   `json:"series"`
		HouseType    string   `json:"house_type"`
		AddrRaw      string   `json:"addr_raw"`
		AddrTown     string   `json:"addr_town"`
		AddrDistrict string   `json:"addr_district"`
		CadastreCode string   `json:"cadastre_code"`
		Images       []string `json:"images"`
		DaysOnMarket int      `json:"days"`
		IsActive     bool     `json:"is_active"`
		Status       string   `json:"status"`
		PublishedAt  *string  `json:"published_at"`
		FirstSeen    *string  `json:"first_seen"`
		LastSeen     *string  `json:"last_seen"`
		ClosedAt     *string  `json:"closed_at"`
		Lng          float64  `json:"lng"`
		Lat          float64  `json:"lat"`
		DropPct      *float64 `json:"drop_pct"`
	}

	resultRows := make([]ListingRow, 0)
	for rows.Next() {
		var r ListingRow
		var imgJSON string
		var pAt, fSeen, lSeen, cAt *string
		var dropPct *float64
		var fCount int64

		err := rows.Scan(
			&r.ID, &r.Portal, &r.Mid, &r.DealType, &r.Category, &r.Title, &r.URL,
			&r.Price, &r.FirstPrice, &r.PricePerM2,
			&r.Area, &r.Rooms, &r.Floor, &r.TotalFloors,
			&r.Series, &r.HouseType, &r.AddrRaw,
			&r.AddrTown, &r.AddrDistrict, &r.CadastreCode,
			&imgJSON, &r.DaysOnMarket, &r.IsActive,
			&pAt, &fSeen, &lSeen, &cAt,
			&r.Lng, &r.Lat,
			&dropPct,
			&fCount,
		)
		if err == nil {
			totalCount = fCount
			r.PublishedAt = pAt
			r.FirstSeen = fSeen
			r.LastSeen = lSeen
			r.ClosedAt = cAt
			r.DropPct = dropPct
			if r.IsActive {
				r.Status = "active"
			} else {
				r.Status = "closed"
			}
			var imgs []string
			if err := json.Unmarshal([]byte(imgJSON), &imgs); err == nil {
				r.Images = imgs
			}
			resultRows = append(resultRows, r)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"mode":  "listings",
		"total": totalCount,
		"page":  page,
		"per":   per,
		"sort":  sortField,
		"dir":   dir,
		"rows":  resultRows,
	})
}

func searchDeals(w http.ResponseWriter, ctx context.Context, qParams url.Values, q, bboxStr string, page, per, offset int) {
	whereClauses := []string{"1=1"}
	args := []any{}
	argIdx := 1

	if q != "" {
		whereClauses = append(whereClauses, fmt.Sprintf("(t.address ILIKE $%d OR t.cadastre_code = $%d)", argIdx, argIdx))
		args = append(args, "%"+q+"%")
		argIdx++
	}

	if pminStr := qParams.Get("pmin"); pminStr != "" {
		if pmin, err := strconv.ParseFloat(pminStr, 64); err == nil && pmin > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("t.amount_eur >= $%d", argIdx))
			args = append(args, pmin)
			argIdx++
		}
	}
	if pmaxStr := qParams.Get("pmax"); pmaxStr != "" {
		if pmax, err := strconv.ParseFloat(pmaxStr, 64); err == nil && pmax > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("t.amount_eur <= $%d", argIdx))
			args = append(args, pmax)
			argIdx++
		}
	}

	if aminStr := qParams.Get("amin"); aminStr != "" {
		if amin, err := strconv.ParseFloat(aminStr, 64); err == nil && amin > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("t.area_m2 >= $%d", argIdx))
			args = append(args, amin)
			argIdx++
		}
	}
	if amaxStr := qParams.Get("amax"); amaxStr != "" {
		if amax, err := strconv.ParseFloat(amaxStr, 64); err == nil && amax > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("t.area_m2 <= $%d", argIdx))
			args = append(args, amax)
			argIdx++
		}
	}

	if dmin := qParams.Get("dmin"); dmin != "" {
		whereClauses = append(whereClauses, fmt.Sprintf("t.deal_date >= $%d::date", argIdx))
		args = append(args, dmin)
		argIdx++
	}
	if dmax := qParams.Get("dmax"); dmax != "" {
		whereClauses = append(whereClauses, fmt.Sprintf("t.deal_date <= $%d::date", argIdx))
		args = append(args, dmax)
		argIdx++
	}

	if ptype := qParams.Get("ptype"); ptype != "" && ptype != "all" {
		whereClauses = append(whereClauses, fmt.Sprintf("t.property_type ILIKE $%d", argIdx))
		args = append(args, "%"+ptype+"%")
		argIdx++
	}

	if bboxStr != "" {
		coords := strings.Split(bboxStr, ",")
		if len(coords) == 4 {
			minX, _ := strconv.ParseFloat(strings.TrimSpace(coords[0]), 64)
			minY, _ := strconv.ParseFloat(strings.TrimSpace(coords[1]), 64)
			maxX, _ := strconv.ParseFloat(strings.TrimSpace(coords[2]), 64)
			maxY, _ := strconv.ParseFloat(strings.TrimSpace(coords[3]), 64)
			whereClauses = append(whereClauses, fmt.Sprintf("t.geom && ST_Transform(ST_MakeEnvelope($%d, $%d, $%d, $%d, 4326), 3857)", argIdx, argIdx+1, argIdx+2, argIdx+3))
			args = append(args, minX, minY, maxX, maxY)
			argIdx += 4
		}
	}

	sortField := qParams.Get("sort")
	dir := strings.ToUpper(qParams.Get("dir"))
	if dir != "ASC" && dir != "DESC" {
		dir = "DESC"
	}

	orderBy := fmt.Sprintf("t.deal_date %s", dir)
	switch sortField {
	case "price":
		orderBy = fmt.Sprintf("t.amount_eur %s NULLS LAST", dir)
	case "ppm":
		orderBy = fmt.Sprintf("t.price_per_m2 %s NULLS LAST", dir)
	case "area":
		orderBy = fmt.Sprintf("t.area_m2 %s NULLS LAST", dir)
	}

	query := fmt.Sprintf(`
		SELECT 
			t.id, COALESCE(t.deal_id, t.id), to_char(t.deal_date, 'YYYY-MM-DD'),
			COALESCE(t.amount_eur, 0), COALESCE(t.price_per_m2, 0), COALESCE(t.area_m2, 0),
			COALESCE(t.property_type, ''), COALESCE(t.address, ''), COALESCE(t.cadastre_code, ''),
			COALESCE(ST_X(ST_Transform(t.geom, 4326)), 0),
			COALESCE(ST_Y(ST_Transform(t.geom, 4326)), 0),
			count(*) OVER() AS full_count
		FROM public.transactions t
		WHERE %s
		ORDER BY %s
		LIMIT $%d OFFSET $%d;
	`, strings.Join(whereClauses, " AND "), orderBy, argIdx, argIdx+1)

	args = append(args, per, offset)

	rows, err := dbPool.Query(ctx, query, args...)
	if err != nil {
		log.Printf("Kļūda meklējot darījumus: %v", err)
		writeJSON(w, http.StatusOK, map[string]any{"mode": "deals", "total": 0, "page": page, "per": per, "rows": []any{}})
		return
	}
	defer rows.Close()

	var totalCount int64 = 0
	type DealRow struct {
		ID           int64   `json:"id"`
		DarijumaID   int64   `json:"darijuma_id"`
		Datums       string  `json:"datums"`
		Summa        float64 `json:"summa"`
		Ppm          float64 `json:"ppm"`
		Area         float64 `json:"area"`
		PropertyType string  `json:"property_type"`
		Adrese       string  `json:"adrese"`
		CadastreCode string  `json:"cadastre_code"`
		Lng          float64 `json:"lng"`
		Lat          float64 `json:"lat"`
	}

	resultRows := make([]DealRow, 0)
	for rows.Next() {
		var r DealRow
		var fCount int64
		err := rows.Scan(
			&r.ID, &r.DarijumaID, &r.Datums, &r.Summa,
			&r.Ppm, &r.Area, &r.PropertyType, &r.Adrese, &r.CadastreCode,
			&r.Lng, &r.Lat, &fCount,
		)
		if err == nil {
			totalCount = fCount
			resultRows = append(resultRows, r)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"mode":  "deals",
		"total": totalCount,
		"page":  page,
		"per":   per,
		"sort":  sortField,
		"dir":   dir,
		"rows":  resultRows,
	})
}

func searchProps(w http.ResponseWriter, ctx context.Context, qParams url.Values, q, bboxStr string, page, per, offset int) {
	whereClauses := []string{"1=1"}
	args := []any{}
	argIdx := 1

	if q != "" {
		whereClauses = append(whereClauses, fmt.Sprintf("(p.code = $%d OR p.address ILIKE $%d)", argIdx, argIdx))
		args = append(args, "%"+q+"%")
		argIdx++
	}

	if vminStr := qParams.Get("vmin"); vminStr != "" {
		if vmin, err := strconv.ParseFloat(vminStr, 64); err == nil && vmin > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("p.cadastral_value >= $%d", argIdx))
			args = append(args, vmin)
			argIdx++
		}
	}
	if vmaxStr := qParams.Get("vmax"); vmaxStr != "" {
		if vmax, err := strconv.ParseFloat(vmaxStr, 64); err == nil && vmax > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("p.cadastral_value <= $%d", argIdx))
			args = append(args, vmax)
			argIdx++
		}
	}

	if aminStr := qParams.Get("amin"); aminStr != "" {
		if amin, err := strconv.ParseFloat(aminStr, 64); err == nil && amin > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("p.area_m2 >= $%d", argIdx))
			args = append(args, amin)
			argIdx++
		}
	}
	if amaxStr := qParams.Get("amax"); amaxStr != "" {
		if amax, err := strconv.ParseFloat(amaxStr, 64); err == nil && amax > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("p.area_m2 <= $%d", argIdx))
			args = append(args, amax)
			argIdx++
		}
	}

	if bboxStr != "" {
		coords := strings.Split(bboxStr, ",")
		if len(coords) == 4 {
			minX, _ := strconv.ParseFloat(strings.TrimSpace(coords[0]), 64)
			minY, _ := strconv.ParseFloat(strings.TrimSpace(coords[1]), 64)
			maxX, _ := strconv.ParseFloat(strings.TrimSpace(coords[2]), 64)
			maxY, _ := strconv.ParseFloat(strings.TrimSpace(coords[3]), 64)
			whereClauses = append(whereClauses, fmt.Sprintf("p.geom && ST_Transform(ST_MakeEnvelope($%d, $%d, $%d, $%d, 4326), 3857)", argIdx, argIdx+1, argIdx+2, argIdx+3))
			args = append(args, minX, minY, maxX, maxY)
			argIdx += 4
		}
	}

	sortField := qParams.Get("sort")
	dir := strings.ToUpper(qParams.Get("dir"))
	if dir != "ASC" && dir != "DESC" {
		dir = "DESC"
	}

	orderBy := fmt.Sprintf("p.cadastral_value %s NULLS LAST", dir)
	if sortField == "area" {
		orderBy = fmt.Sprintf("p.area_m2 %s NULLS LAST", dir)
	}

	query := fmt.Sprintf(`
		SELECT 
			p.id, p.code, 'PARCEL' AS otype, COALESCE(p.address, ''),
			COALESCE(p.area_m2, 0), COALESCE(p.status, ''), COALESCE(p.cadastral_value, 0),
			COALESCE(ST_X(ST_Centroid(ST_Transform(p.geom, 4326))), 0),
			COALESCE(ST_Y(ST_Centroid(ST_Transform(p.geom, 4326))), 0),
			count(*) OVER() AS full_count
		FROM public.parcels p
		WHERE %s
		ORDER BY %s
		LIMIT $%d OFFSET $%d;
	`, strings.Join(whereClauses, " AND "), orderBy, argIdx, argIdx+1)

	args = append(args, per, offset)

	rows, err := dbPool.Query(ctx, query, args...)
	if err != nil {
		log.Printf("Kļūda meklējot īpašumus: %v", err)
		writeJSON(w, http.StatusOK, map[string]any{"mode": "props", "total": 0, "page": page, "per": per, "rows": []any{}})
		return
	}
	defer rows.Close()

	var totalCount int64 = 0
	type PropRow struct {
		ID             int64   `json:"id"`
		Code           string  `json:"code"`
		OType          string  `json:"otype"`
		Address        string  `json:"address"`
		Area           float64 `json:"area"`
		Status         string  `json:"status"`
		CadastralValue float64 `json:"kad_value"`
		Lng            float64 `json:"lng"`
		Lat            float64 `json:"lat"`
	}

	resultRows := make([]PropRow, 0)
	for rows.Next() {
		var r PropRow
		var fCount int64
		err := rows.Scan(
			&r.ID, &r.Code, &r.OType, &r.Address,
			&r.Area, &r.Status, &r.CadastralValue,
			&r.Lng, &r.Lat, &fCount,
		)
		if err == nil {
			totalCount = fCount
			resultRows = append(resultRows, r)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"mode":  "props",
		"total": totalCount,
		"page":  page,
		"per":   per,
		"sort":  sortField,
		"dir":   dir,
		"rows":  resultRows,
	})
}

func searchAuctions(w http.ResponseWriter, ctx context.Context, qParams url.Values, q, bboxStr string, page, per, offset int) {
	// Izsoles ir sludinājumi ar deal_type = 'auction' vai category = 'auctions'
	qParams.Set("deal", "auction")
	searchListings(w, ctx, qParams, q, bboxStr, page, per, offset)
}


