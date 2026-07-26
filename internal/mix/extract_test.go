package mix_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ra2web/redalert2/internal/mix"
)

func TestUnpackSources(t *testing.T) {
	src := filepath.Join("..", "..", "public", "game-res")
	ra2 := filepath.Join(src, "ra2.mix")
	if _, err := os.Stat(ra2); err != nil {
		t.Skip("public/game-res/ra2.mix not present")
	}
	out := t.TempDir()
	if err := mix.UnpackSources(src, out, t.Logf); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"conquer.mix", "local.mix", "manifest.json", "language.mix"} {
		st, err := os.Stat(filepath.Join(out, name))
		if err != nil {
			t.Fatalf("missing %s: %v", name, err)
		}
		if st.Size() == 0 && name != "tem.mix" {
			t.Fatalf("%s is empty", name)
		}
	}
	audio := filepath.Join(out, "audio.bag")
	if st, err := os.Stat(audio); err != nil || st.Size() == 0 {
		t.Fatalf("audio.bag missing or empty: %v", err)
	}
}
