package mix

import (
	"os"
	"testing"
)

func TestOpenRa2Mix(t *testing.T) {
	const path = "../../public/game-res/ra2.mix"
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("ra2.mix not present: %v", err)
	}
	arc, err := Open(data)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !arc.Contains("conquer.mix") {
		t.Fatal(`Contains("conquer.mix") = false`)
	}
	body, err := arc.ReadFile("conquer.mix")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if len(body) == 0 {
		t.Fatal("ReadFile returned empty")
	}
}
