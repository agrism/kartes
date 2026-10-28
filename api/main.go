package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
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
