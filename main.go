package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/ra2web/redalert2/internal/hub"
	"github.com/ra2web/redalert2/internal/mixcache"
)

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	staticDir := flag.String("static", "dist", "Static files directory")
	gameResDir := flag.String("game-res", "public/game-res", "Source MIX directory (ra2/language/multi/theme only)")
	mixCacheDir := flag.String("mix-cache", "data/mix-cache", "Derived flat MIX cache (auto-built, do not edit)")
	skipMixCache := flag.Bool("skip-mix-cache", false, "Do not build/serve mix cache")
	forceMixCache := flag.Bool("force-mix-cache", false, "Rebuild mix cache even if stamp matches")
	flag.Parse()

	absStatic, err := filepath.Abs(*staticDir)
	if err != nil {
		log.Fatal(err)
	}
	if st, err := os.Stat(absStatic); err != nil || !st.IsDir() {
		log.Fatalf("static directory %q not found; run frontend build first (e.g. bun run build)", absStatic)
	}

	absGameRes, err := filepath.Abs(*gameResDir)
	if err != nil {
		log.Fatal(err)
	}
	absMixCache, err := filepath.Abs(*mixCacheDir)
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	h := hub.New()
	mux.HandleFunc("/ws", h.ServeWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// Always expose source mixes (operators manage only these).
	if st, err := os.Stat(absGameRes); err == nil && st.IsDir() {
		mux.Handle("/game-res/", http.StripPrefix("/game-res/", http.FileServer(http.Dir(absGameRes))))
		log.Printf("serving source game-res from %s", absGameRes)
	}

	if !*skipMixCache {
		if err := mixcache.Ensure(mixcache.Options{
			SourceDir: absGameRes,
			CacheDir:  absMixCache,
			Force:     *forceMixCache,
		}); err != nil {
			log.Fatalf("mix cache: %v", err)
		}
		mux.Handle("/mix-cache/", mixcache.FileServer(absMixCache))
		log.Printf("serving mix-cache from %s", absMixCache)
	}

	mux.Handle("/", spaFileServer(absStatic))

	log.Printf("serving static from %s", absStatic)
	log.Printf("listening on %s (ws /ws, health /health, mix-cache /mix-cache/)", *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		log.Fatal(err)
	}
}

// spaFileServer serves files from root and falls back to index.html for unknown paths.
func spaFileServer(root string) http.Handler {
	fs := http.FileServer(http.Dir(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(root, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}
		// directory with index.html
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			index := filepath.Join(path, "index.html")
			if _, err := os.Stat(index); err == nil {
				fs.ServeHTTP(w, r)
				return
			}
		}
		http.ServeFile(w, r, filepath.Join(root, "index.html"))
	})
}
