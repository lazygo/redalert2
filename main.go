package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/ra2web/redalert2/internal/hub"
)

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	staticDir := flag.String("static", "dist", "Static files directory")
	flag.Parse()

	absStatic, err := filepath.Abs(*staticDir)
	if err != nil {
		log.Fatal(err)
	}
	if st, err := os.Stat(absStatic); err != nil || !st.IsDir() {
		log.Fatalf("static directory %q not found; run frontend build first (e.g. bun run build)", absStatic)
	}

	h := hub.New()
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", h.ServeWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.Handle("/", spaFileServer(absStatic))

	log.Printf("serving static from %s", absStatic)
	log.Printf("listening on %s (ws /ws, health /health)", *addr)
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
