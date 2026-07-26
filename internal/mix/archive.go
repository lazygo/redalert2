package mix

import (
	"encoding/binary"
	"fmt"
)

const (
	mixFlagChecksum  = 0x00010000
	mixFlagEncrypted = 0x00020000
	mixHeaderStart   = 84
	mixEntrySize     = 12
)

// Entry is a MIX index record (offset/length relative to DataStart).
type Entry struct {
	Offset uint32
	Length uint32
}

// Archive is an opened Westwood MIX (RA2 encrypted or unencrypted TD header).
type Archive struct {
	Index     map[uint32]Entry
	DataStart int
	data      []byte
}

// Open parses a MIX archive from memory.
func Open(data []byte) (*Archive, error) {
	if len(data) < 4 {
		return nil, fmt.Errorf("mix: data too short")
	}
	a := &Archive{
		Index: make(map[uint32]Entry),
		data:  data,
	}
	flags := binary.LittleEndian.Uint32(data[0:4])
	isWestwood := flags&^(mixFlagChecksum|mixFlagEncrypted) == 0
	pos := 4
	if isWestwood {
		if flags&mixFlagEncrypted != 0 {
			ds, err := a.parseRaHeader(data)
			if err != nil {
				return nil, err
			}
			a.DataStart = ds
			return a, nil
		}
	} else {
		pos = 0
	}
	ds, err := a.parseTdHeader(data[pos:])
	if err != nil {
		return nil, err
	}
	a.DataStart = pos + ds
	return a, nil
}

func (a *Archive) parseRaHeader(data []byte) (int, error) {
	if len(data) < mixHeaderStart+8 {
		return 0, fmt.Errorf("mix: encrypted header truncated")
	}
	keySource := data[4:84]
	key := DecryptBlowfishKey(keySource)
	bf := NewBlowfish(key)

	// First encrypted block: 2 uint32 LE at offset 84.
	block0 := make([]uint32, 2)
	block0[0] = binary.LittleEndian.Uint32(data[84:88])
	block0[1] = binary.LittleEndian.Uint32(data[88:92])
	dec0 := bf.Decrypt(block0)
	dec0Bytes := make([]byte, 8)
	binary.LittleEndian.PutUint32(dec0Bytes[0:4], dec0[0])
	binary.LittleEndian.PutUint32(dec0Bytes[4:8], dec0[1])

	count := int(binary.LittleEndian.Uint16(dec0Bytes[0:2]))
	// size uint32 at [2:6] unused for indexing
	indexSize := 6 + count*mixEntrySize
	t := (3 + indexSize) / 4
	wordCount := t + (t % 2)
	need := mixHeaderStart + wordCount*4
	if len(data) < need {
		return 0, fmt.Errorf("mix: encrypted index truncated")
	}

	words := make([]uint32, wordCount)
	for i := 0; i < wordCount; i++ {
		off := mixHeaderStart + i*4
		words[i] = binary.LittleEndian.Uint32(data[off : off+4])
	}
	dec := bf.Decrypt(words)
	decBytes := make([]byte, len(dec)*4)
	for i, w := range dec {
		binary.LittleEndian.PutUint32(decBytes[i*4:], w)
	}

	if _, err := a.parseTdHeader(decBytes); err != nil {
		return 0, err
	}

	// dataStart = headerStart + indexSize + ((1 + (~indexSize >>> 0)) & 7)
	pad := int((1 + (^uint32(indexSize))) & 7)
	return mixHeaderStart + indexSize + pad, nil
}

// parseTdHeader reads a TD-style header from buf and returns the byte position
// after the index (same as MixFile.parseTdHeader return value).
func (a *Archive) parseTdHeader(buf []byte) (int, error) {
	if len(buf) < 6 {
		return 0, fmt.Errorf("mix: TD header truncated")
	}
	count := int(binary.LittleEndian.Uint16(buf[0:2]))
	// size at [2:6]
	pos := 6
	for r := 0; r < count; r++ {
		if pos+12 > len(buf) {
			break
		}
		hash := binary.LittleEndian.Uint32(buf[pos : pos+4])
		offset := binary.LittleEndian.Uint32(buf[pos+4 : pos+8])
		length := binary.LittleEndian.Uint32(buf[pos+8 : pos+12])
		pos += 12
		if _, exists := a.Index[hash]; !exists {
			a.Index[hash] = Entry{Offset: offset, Length: length}
		}
	}
	return pos, nil
}

// Contains reports whether the archive has an entry for name.
func (a *Archive) Contains(name string) bool {
	_, ok := a.Index[HashFilename(name)]
	return ok
}

// ReadFile returns a copy of the named entry's bytes.
func (a *Archive) ReadFile(name string) ([]byte, error) {
	ent, ok := a.Index[HashFilename(name)]
	if !ok {
		return nil, fmt.Errorf("mix: file %q not found", name)
	}
	start := a.DataStart + int(ent.Offset)
	end := start + int(ent.Length)
	if start < 0 || end > len(a.data) || start > end {
		return nil, fmt.Errorf("mix: entry %q out of range", name)
	}
	out := make([]byte, ent.Length)
	copy(out, a.data[start:end])
	return out, nil
}
