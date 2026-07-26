package mix

// Blowfish matches src/data/encoding/Blowfish.ts (Westwood ECB with byte-swapped blocks).

type Blowfish struct {
	p [18]uint32
	s [4][256]uint32
}

func byteSwap32(v uint32) uint32 {
	v = (v << 16) | (v >> 16)
	return ((v << 8) & 0xFF00FF00) | ((v >> 8) & 0x00FF00FF)
}

func NewBlowfish(key []byte) *Blowfish {
	bf := &Blowfish{}
	copy(bf.p[:], blowfishPInit[:])
	for i := 0; i < 4; i++ {
		copy(bf.s[i][:], blowfishSInit[i][:])
	}
	if len(key) == 0 {
		key = []byte{0}
	}
	ki := 0
	for i := 0; i < 18; i++ {
		var k uint32
		for n := 0; n < 4; n++ {
			k = (k << 8) | uint32(key[ki%len(key)])
			ki++
		}
		bf.p[i] ^= k
	}
	var l, r uint32
	for i := 0; i < 18; {
		l, r = bf.encryptBlock(l, r)
		bf.p[i] = l
		i++
		bf.p[i] = r
		i++
	}
	for i := 0; i < 4; i++ {
		for j := 0; j < 256; {
			l, r = bf.encryptBlock(l, r)
			bf.s[i][j] = l
			j++
			bf.s[i][j] = r
			j++
		}
	}
	return bf
}

func (bf *Blowfish) sBox(val uint32, boxIndex int) uint32 {
	return bf.s[boxIndex][(val>>((3-boxIndex)<<3))&255]
}

func (bf *Blowfish) f(val uint32) uint32 {
	return (((bf.sBox(val, 0) + bf.sBox(val, 1)) ^ bf.sBox(val, 2)) + bf.sBox(val, 3))
}

func (bf *Blowfish) round(l, r uint32, pIndex int) uint32 {
	return l ^ (bf.f(r) ^ bf.p[pIndex])
}

func (bf *Blowfish) encryptBlock(l, r uint32) (uint32, uint32) {
	l ^= bf.p[0]
	swap := false
	for i := 1; i <= 16; i++ {
		if swap {
			l = bf.round(l, r, i)
		} else {
			r = bf.round(r, l, i)
		}
		swap = !swap
	}
	r ^= bf.p[17]
	return r, l
}

func (bf *Blowfish) decryptBlock(l, r uint32) (uint32, uint32) {
	l ^= bf.p[17]
	swap := false
	for i := 16; i >= 1; i-- {
		if swap {
			l = bf.round(l, r, i)
		} else {
			r = bf.round(r, l, i)
		}
		swap = !swap
	}
	r ^= bf.p[0]
	return r, l
}

// Decrypt decrypts a little-endian uint32 word stream (as in the TS port).
func (bf *Blowfish) Decrypt(data []uint32) []uint32 {
	out := make([]uint32, len(data))
	for i := 0; i+1 < len(data); i += 2 {
		l := byteSwap32(data[i])
		r := byteSwap32(data[i+1])
		l, r = bf.decryptBlock(l, r)
		out[i] = byteSwap32(l)
		out[i+1] = byteSwap32(r)
	}
	return out
}

// DecryptBytes decrypts len(src) bytes (must be multiple of 8) in place-style copy.
func (bf *Blowfish) DecryptBytes(src []byte) []byte {
	if len(src)%8 != 0 {
		panic("blowfish: ciphertext length must be multiple of 8")
	}
	words := make([]uint32, len(src)/4)
	for i := 0; i < len(words); i++ {
		words[i] = uint32(src[i*4]) | uint32(src[i*4+1])<<8 | uint32(src[i*4+2])<<16 | uint32(src[i*4+3])<<24
	}
	dec := bf.Decrypt(words)
	out := make([]byte, len(src))
	for i, w := range dec {
		out[i*4] = byte(w)
		out[i*4+1] = byte(w >> 8)
		out[i*4+2] = byte(w >> 16)
		out[i*4+3] = byte(w >> 24)
	}
	return out
}
