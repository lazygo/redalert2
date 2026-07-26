// Package mixcache builds a derived flat asset cache from the few source MIX
// files (ra2/language/multi/theme). The cache is regenerated when sources change;
// operators only maintain the original mixes.
package mixcache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ra2web/redalert2/internal/mix"
)

const stampFile = ".cache-stamp.json"

// SourceMixes are the only files operators need to keep in the game-res directory.
var SourceMixes = []string{
	"ra2.mix",
	"language.mix",
	"multi.mix",
	"theme.mix",
}

type stamp struct {
	BuiltAt     time.Time `json:"builtAt"`
	SourceHash  string    `json:"sourceHash"`
	Unpacker    string    `json:"unpacker"`
	SourceFiles []string  `json:"sourceFiles"`
}

// Options control cache location.
type Options struct {
	// SourceDir contains the original mixes (ra2/language/multi/theme).
	SourceDir string
	// CacheDir receives extracted nested packs + flat manifest.json.
	CacheDir string
	// Force rebuild even if stamp matches.
	Force  bool
	Logger *log.Logger
}

func (o Options) logf(format string, args ...any) {
	if o.Logger != nil {
		o.Logger.Printf(format, args...)
		return
	}
	log.Printf(format, args...)
}

// Ensure builds the cache if missing or stale relative to source mix mtimes/sizes.
func Ensure(opts Options) error {
	if opts.SourceDir == "" || opts.CacheDir == "" {
		return fmt.Errorf("mixcache: SourceDir and CacheDir are required")
	}
	if err := os.MkdirAll(opts.CacheDir, 0o755); err != nil {
		return err
	}
	hash, files, err := hashSources(opts.SourceDir)
	if err != nil {
		return err
	}
	if !opts.Force {
		if prev, ok := readStamp(filepath.Join(opts.CacheDir, stampFile)); ok && prev.SourceHash == hash {
			if _, err := os.Stat(filepath.Join(opts.CacheDir, "manifest.json")); err == nil {
				opts.logf("mixcache: up to date (%s, %d source files)", hash[:12], len(files))
				return nil
			}
		}
	}
	opts.logf("mixcache: building cache from %s → %s", opts.SourceDir, opts.CacheDir)
	if err := rebuild(opts); err != nil {
		return err
	}
	st := stamp{
		BuiltAt:     time.Now().UTC(),
		SourceHash:  hash,
		Unpacker:    "internal/mix (pure Go)",
		SourceFiles: files,
	}
	raw, _ := json.MarshalIndent(st, "", "  ")
	if err := os.WriteFile(filepath.Join(opts.CacheDir, stampFile), append(raw, '\n'), 0o644); err != nil {
		return err
	}
	opts.logf("mixcache: ready (hash=%s)", hash[:12])
	return nil
}

func rebuild(opts Options) error {
	ra2 := filepath.Join(opts.SourceDir, "ra2.mix")
	if _, err := os.Stat(ra2); err != nil {
		return fmt.Errorf("mixcache: missing %s: %w", ra2, err)
	}
	// Clear previous extracted artifacts but keep the directory.
	entries, _ := os.ReadDir(opts.CacheDir)
	for _, e := range entries {
		_ = os.RemoveAll(filepath.Join(opts.CacheDir, e.Name()))
	}
	return mix.UnpackSources(opts.SourceDir, opts.CacheDir, opts.logf)
}

func hashSources(sourceDir string) (string, []string, error) {
	h := sha256.New()
	var present []string
	for _, name := range SourceMixes {
		path := filepath.Join(sourceDir, name)
		st, err := os.Stat(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return "", nil, err
		}
		present = append(present, name)
		fmt.Fprintf(h, "%s|%d|%d\n", strings.ToLower(name), st.Size(), st.ModTime().UnixNano())
	}
	if len(present) == 0 {
		return "", nil, fmt.Errorf("mixcache: no source mixes in %s", sourceDir)
	}
	if !contains(present, "ra2.mix") {
		return "", nil, fmt.Errorf("mixcache: ra2.mix is required in %s", sourceDir)
	}
	return hex.EncodeToString(h.Sum(nil)), present, nil
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if strings.EqualFold(s, want) {
			return true
		}
	}
	return false
}

func readStamp(path string) (stamp, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return stamp{}, false
	}
	var st stamp
	if json.Unmarshal(raw, &st) != nil || st.SourceHash == "" {
		return stamp{}, false
	}
	return st, true
}

// FileServer serves the derived cache directory (flat mixes + manifest).
func FileServer(cacheDir string) http.Handler {
	return http.StripPrefix("/mix-cache/", http.FileServer(http.Dir(cacheDir)))
}
