package mix

import (
	"strings"
)

func crc32Westwood(data []byte) uint32 {
	crc := uint32(0xFFFFFFFF)
	for _, b := range data {
		crc = (crc >> 8) ^ crc32Table[(crc&0xFF)^uint32(b)]
	}
	return crc ^ 0xFFFFFFFF
}

// HashFilename matches MixEntry.hashFilename (RA2 / TS CRC id).
func HashFilename(filename string) uint32 {
	name := strings.ToUpper(filename)
	origLen := len(name)
	r := origLen >> 2
	if origLen&3 != 0 {
		appendCode := origLen - (r << 2)
		name += string(rune(appendCode))
		numPad := 3 - (origLen & 3)
		padIdx := r << 2
		if padIdx >= len(name) {
			padIdx = 0
		}
		pad := name[padIdx]
		for i := 0; i < numPad; i++ {
			name += string(pad)
		}
	}
	return crc32Westwood([]byte(name))
}
