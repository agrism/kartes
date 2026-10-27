package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
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
	mux.HandleFunc("GET /api/health", handleHealth)
	mux.HandleFunc("GET /api/parcel-info", handleParcelInfo)
	mux.HandleFunc("GET /api/address-suggest", handleAddressSuggest)
	mux.HandleFunc("GET /api/transactions", handleTransactions)

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

// Struktūras attālināto kadastra datu nolasīšanai
type RemoteParcelData struct {
	Code           string
	Address        string
	AreaM2         float64
	Status         string
	CadastralValue float64
	GeomJSON       string
}

type kadastraAddress struct {
	Street    *string `json:"street"`
	House     *string `json:"house"`
	Town      *string `json:"town"`
	PostIndex *string `json:"post_index"`
}

type kadastraParcel struct {
	StatusName string `json:"status_name"`
	Area       string `json:"area"`
}

type kadastraValuation struct {
	ValueType string `json:"value_type"`
	Value     string `json:"value"`
	ValueDate string `json:"value_date"`
}

func fetchRemoteParcelInfo(ctx context.Context, code string) (*RemoteParcelData, error) {
	reqURL := fmt.Sprintf("https://kadastrakarte.lv/api/parcel-info.php?code=%s", url.QueryEscape(code))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	req.Header.Set("Referer", "https://kadastrakarte.lv/ipasumu-karte")
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("remote API returned status %d", resp.StatusCode)
	}

	var raw struct {
		ResolvedCode     *string             `json:"resolved_code"`
		Address          *kadastraAddress    `json:"address"`
		Parcel           *kadastraParcel     `json:"parcel"`
		ParcelValuations []kadastraValuation `json:"parcel_valuations"`
		Geom             any                 `json:"geom"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}

	if raw.Parcel == nil && raw.Address == nil && (raw.ResolvedCode == nil || *raw.ResolvedCode == "") {
		return nil, fmt.Errorf("zemes vienība nav atrasta")
	}

	data := &RemoteParcelData{
		Code:   code,
		Status: "Reģistrēts",
	}

	if raw.ResolvedCode != nil && *raw.ResolvedCode != "" {
		data.Code = *raw.ResolvedCode
	}

	if raw.Address != nil {
		var parts []string
		var streetHouse string
		if raw.Address.Street != nil && *raw.Address.Street != "" {
			streetHouse = strings.TrimSpace(*raw.Address.Street)
		}
		if raw.Address.House != nil && *raw.Address.House != "" {
			h := strings.TrimSpace(*raw.Address.House)
			if streetHouse != "" {
				streetHouse += " " + h
			} else {
				streetHouse = h
			}
		}
		if streetHouse != "" {
			parts = append(parts, streetHouse)
		}
		if raw.Address.Town != nil && *raw.Address.Town != "" {
			parts = append(parts, strings.TrimSpace(*raw.Address.Town))
		}
		if raw.Address.PostIndex != nil && *raw.Address.PostIndex != "" {
			p := strings.TrimSpace(*raw.Address.PostIndex)
			if strings.HasPrefix(p, "LV") && len(p) == 6 && p[2] != '-' {
				p = "LV-" + p[2:]
			}
			parts = append(parts, p)
		}
		data.Address = strings.Join(parts, ", ")
	}

	if raw.Parcel != nil {
		if raw.Parcel.StatusName != "" {
			data.Status = raw.Parcel.StatusName
		}
		if raw.Parcel.Area != "" {
			if a, err := strconv.ParseFloat(raw.Parcel.Area, 64); err == nil {
				data.AreaM2 = a
			}
		}
	}

	for _, v := range raw.ParcelValuations {
		if val, err := strconv.ParseFloat(v.Value, 64); err == nil && val > 0 {
			if data.CadastralValue == 0 || v.ValueType == "fisc" {
				data.CadastralValue = val
				if v.ValueType == "fisc" {
					break
				}
			}
		}
	}

	if raw.Geom != nil {
		switch g := raw.Geom.(type) {
		case string:
			data.GeomJSON = g
		default:
			if b, err := json.Marshal(g); err == nil && len(b) > 2 {
				data.GeomJSON = string(b)
			}
		}
	}

	return data, nil
}

func cacheParcelToDB(code, address string, areaM2 float64, status string, cadValue float64, geomJSON string) {
	if dbPool == nil || code == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if geomJSON != "" && strings.Contains(geomJSON, "coordinates") {
		_, err := dbPool.Exec(ctx, `
			INSERT INTO public.parcels (code, address, area_m2, status, cadastral_value, geom, updated_at)
			VALUES ($1, $2, $3, $4, $5, ST_Multi(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($6), 4326), 3857)), NOW())
			ON CONFLICT (code) DO UPDATE SET
				address = CASE WHEN EXCLUDED.address != '' THEN EXCLUDED.address ELSE public.parcels.address END,
				area_m2 = CASE WHEN EXCLUDED.area_m2 > 0 THEN EXCLUDED.area_m2 ELSE public.parcels.area_m2 END,
				status = CASE WHEN EXCLUDED.status != '' THEN EXCLUDED.status ELSE public.parcels.status END,
				cadastral_value = CASE WHEN EXCLUDED.cadastral_value > 0 THEN EXCLUDED.cadastral_value ELSE public.parcels.cadastral_value END,
				geom = COALESCE(EXCLUDED.geom, public.parcels.geom),
				updated_at = NOW();
		`, code, address, areaM2, status, cadValue, geomJSON)
		if err == nil {
			return
		}
	}

	_, _ = dbPool.Exec(ctx, `
		INSERT INTO public.parcels (code, address, area_m2, status, cadastral_value, updated_at)
		VALUES ($1, $2, $3, $4, $5, NOW())
		ON CONFLICT (code) DO UPDATE SET
			address = CASE WHEN EXCLUDED.address != '' THEN EXCLUDED.address ELSE public.parcels.address END,
			area_m2 = CASE WHEN EXCLUDED.area_m2 > 0 THEN EXCLUDED.area_m2 ELSE public.parcels.area_m2 END,
			status = CASE WHEN EXCLUDED.status != '' THEN EXCLUDED.status ELSE public.parcels.status END,
			cadastral_value = CASE WHEN EXCLUDED.cadastral_value > 0 THEN EXCLUDED.cadastral_value ELSE public.parcels.cadastral_value END,
			updated_at = NOW();
	`, code, address, areaM2, status, cadValue)
}

// /api/parcel-info?code=01000070001
func handleParcelInfo(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Parametrs 'code' ir obligāts"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()

	query := `
		SELECT code, COALESCE(address, ''), COALESCE(area_m2, 0), COALESCE(status, ''), COALESCE(cadastral_value, 0)
		FROM public.parcels
		WHERE code = $1
		LIMIT 1;
	`

	var pCode, address, status string
	var areaM2, cadValue float64

	err := dbPool.QueryRow(ctx, query, code).Scan(&pCode, &address, &areaM2, &status, &cadValue)
	if err != nil || areaM2 == 0 {
		// Rezerves variants: ielādē no kadastrakarte.lv
		remoteInfo, rErr := fetchRemoteParcelInfo(ctx, code)
		if rErr == nil && remoteInfo != nil {
			pCode = remoteInfo.Code
			if remoteInfo.Address != "" {
				address = remoteInfo.Address
			}
			if remoteInfo.AreaM2 > 0 {
				areaM2 = remoteInfo.AreaM2
			}
			if remoteInfo.Status != "" {
				status = remoteInfo.Status
			}
			if remoteInfo.CadastralValue > 0 {
				cadValue = remoteInfo.CadastralValue
			}

			// Sinhronizē/kešo fonā uz vietējo PostgreSQL
			go cacheParcelToDB(pCode, address, areaM2, status, cadValue, remoteInfo.GeomJSON)
		} else if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{
				"error": fmt.Sprintf("Zemes vienība ar kodu '%s' netika atrasta", code),
			})
			return
		}
	}

	// 1. Meklējam ēkas energoefektivitātes sertifikātu
	type EnergyCert struct {
		Class        string   `json:"class"`
		HeatingKwhM2 *float64 `json:"heating_kwh_m2,omitempty"`
		ValidUntil   string   `json:"valid_until,omitempty"`
		Status       string   `json:"status,omitempty"`
	}
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

	// 2. Meklējam piesārņotās vietas 500m rādiusā
	type PollutionNearby struct {
		Name      string  `json:"name"`
		Category  string  `json:"category"`
		SiteType  string  `json:"site_type"`
		DistanceM float64 `json:"distance_m"`
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

	writeJSON(w, http.StatusOK, map[string]any{
		"code":             pCode,
		"address":          address,
		"area_m2":          areaM2,
		"status":           status,
		"cadastral_value":  cadValue,
		"energy_cert":      cert,
		"pollution_nearby": pollutionList,
	})
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

type rawRemoteTx struct {
	DarijumaID  json.Number `json:"darijuma_id"`
	Datums       string      `json:"datums"`
	Summa        json.Number `json:"summa"`
	Adrese       string      `json:"adrese"`
	ZemesPlatiba json.Number `json:"zemes_platiba"`
	VaiApbuveta  json.Number `json:"vai_apbuveta"`
}

func fetchRemoteParcelTransactions(ctx context.Context, cad string) ([]Deal, error) {
	reqURL := fmt.Sprintf("https://kadastrakarte.lv/api/parcel-transactions.php?code=%s", url.QueryEscape(cad))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	req.Header.Set("Referer", "https://kadastrakarte.lv/ipasumu-karte")
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 4 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("remote API returned status %d", resp.StatusCode)
	}

	var raw struct {
		Found bool          `json:"found"`
		ZV    []rawRemoteTx `json:"zv"`
		ZVB   []rawRemoteTx `json:"zvb"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}

	deals := make([]Deal, 0)

	convert := func(items []rawRemoteTx, defaultType string) {
		for _, it := range items {
			id, _ := it.DarijumaID.Int64()
			if id == 0 {
				continue
			}
			sum, _ := it.Summa.Float64()
			area, _ := it.ZemesPlatiba.Float64()
			dDate, dErr := time.Parse("2006-01-02", it.Datums)
			if dErr != nil {
				dDate = time.Now()
			}

			var ppm float64
			if area > 0 && sum > 0 {
				ppm = math.Round((sum/area)*100) / 100
			}

			propType := defaultType
			if vaiApb, _ := it.VaiApbuveta.Int64(); vaiApb == 1 && defaultType == "Zeme" {
				propType = "Zeme ar būvi"
			}

			deals = append(deals, Deal{
				DealID:       id,
				CadastreCode: cad,
				DealDate:     dDate,
				AmountEur:    sum,
				AreaM2:       area,
				PricePerM2:   ppm,
				PropertyType: propType,
				Address:      it.Adrese,
			})
		}
	}

	convert(raw.ZV, "Zeme")
	convert(raw.ZVB, "Būve un zeme")

	return deals, nil
}

func cacheDealsToDB(deals []Deal) {
	if dbPool == nil || len(deals) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	for _, d := range deals {
		_, _ = dbPool.Exec(ctx, `
			INSERT INTO public.transactions (deal_id, cadastre_code, deal_date, amount_eur, area_m2, price_per_m2, property_type, address)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (deal_id) DO NOTHING;
		`, d.DealID, d.CadastreCode, d.DealDate, d.AmountEur, d.AreaM2, d.PricePerM2, d.PropertyType, d.Address)
	}
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

	if len(deals) == 0 {
		// Rezerves variants: ja vietējā DB vēl nav šī kadastra darījumu, ielādē no attālinātā API
		remoteDeals, rErr := fetchRemoteParcelTransactions(ctx, cad)
		if rErr == nil && len(remoteDeals) > 0 {
			deals = remoteDeals
			go cacheDealsToDB(deals)
		}
	}

	if deals == nil {
		deals = []Deal{}
	}

	writeJSON(w, http.StatusOK, deals)
}
