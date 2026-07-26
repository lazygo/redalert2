package mix

import "encoding/binary"

// Public key string and base64-like decode table from BlowfishKey.ts.
const pubkeyStr = "AihRvNoIbTn85FZRYNZRcT+i6KpU+maCsEqr3Q5q+LDB5tH7Tz2qQ38V"

// decodeTable matches Int8Array `a` in BlowfishKey.ts (-1 / 0-63).
var decodeTable = [256]int8{
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, 62, -1, -1, -1, 63, 52, 53, 54,
	55, 56, 57, 58, 59, 60, 61, -1, -1, -1, -1, -1, -1, -1, 0, 1, 2, 3,
	4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
	22, 23, 24, 25, -1, -1, -1, -1, -1, -1, 26, 27, 28, 29, 30, 31, 32,
	33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
	50, 51, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
	-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
}

type pubkey struct {
	key1 [64]uint32
	key2 [64]uint32
	len  int
}

type blowfishKey struct {
	pubkey        pubkey
	glob1         [64]uint32
	glob2         [130]uint32
	glob1Hi       [4]uint32
	glob1HiInv    [4]uint32
	glob1Bitlen   int
	glob1LenX2    int
	glob1HiBitlen uint32
	glob1HiInvLo  uint32
	glob1HiInvHi  uint32
}

// DecryptBlowfishKey returns the first 56 bytes of the decrypted Blowfish key
// (same as TS `new BlowfishKey().decryptKey(e)` → `t.subarray(0, 56)`).
func DecryptBlowfishKey(keySource []byte) []byte {
	bk := &blowfishKey{}
	return bk.decryptKey(keySource)
}

func getU16(w []uint32, idx int) uint16 {
	v := w[idx>>1]
	if idx&1 == 0 {
		return uint16(v)
	}
	return uint16(v >> 16)
}

func setU16(w []uint32, idx int, val uint16) {
	i := idx >> 1
	if idx&1 == 0 {
		w[i] = (w[i] & 0xFFFF0000) | uint32(val)
	} else {
		w[i] = (w[i] & 0x0000FFFF) | (uint32(val) << 16)
	}
}

func wordsAsBytes(w []uint32) []byte {
	b := make([]byte, len(w)*4)
	for i, v := range w {
		binary.LittleEndian.PutUint32(b[i*4:], v)
	}
	return b
}

func writeBytesIntoWords(w []uint32, src []byte) {
	b := wordsAsBytes(w)
	copy(b, src)
	for i := range w {
		w[i] = binary.LittleEndian.Uint32(b[i*4:])
	}
}

func (bk *blowfishKey) initBignum(e []uint32, t uint32, n int) {
	for r := 0; r < n; r++ {
		e[r] = 0
	}
	e[0] = t
}

func (bk *blowfishKey) moveKeyToBig(e []uint32, t []byte, i, r int) {
	var s byte
	if len(t) > 0 && t[0]&128 != 0 {
		s = 255
	}
	a := make([]byte, 4*r)
	n := 4 * r
	for n > i {
		a[n-1] = s
		n--
	}
	for n > 0 {
		a[n-1] = t[i-n]
		n--
	}
	for j := 0; j < r; j++ {
		e[j] = binary.LittleEndian.Uint32(a[j*4:])
	}
}

func (bk *blowfishKey) keyToBignum(e []uint32, t []byte, i int) {
	a := 0
	if len(t) > 0 && t[a] == 2 {
		a++
		var r int
		if t[a]&128 != 0 {
			r = 0
			for s := 0; s < int(t[a]&127); s++ {
				r = int((uint32(r<<8) | uint32(t[a+s+1])))
			}
			a += 1 + int(t[a]&127)
		} else {
			r = int(t[a])
			a++
		}
		if r <= 4*i {
			bk.moveKeyToBig(e, t[a:], r, i)
		}
	}
}

func (bk *blowfishKey) lenBignum(e []uint32, t int) int {
	i := t - 1
	for i >= 0 && e[i] == 0 {
		i--
	}
	return i + 1
}

func (bk *blowfishKey) bitlenBignum(e []uint32, t int) int {
	i := bk.lenBignum(e, t)
	if i == 0 {
		return 0
	}
	r := 32 * i
	s := uint32(2147483648)
	for s&e[i-1] == 0 {
		s >>= 1
		r--
	}
	return r
}

func tableU32(c byte) uint32 {
	// Int8Array value >>> 0
	return uint32(int32(decodeTable[c]))
}

func tableU32Masked(c byte) uint32 {
	// 255 & Int8Array value
	return 255 & uint32(int32(decodeTable[c]))
}

func (bk *blowfishKey) initPubkey() {
	bk.initBignum(bk.pubkey.key2[:], 65537, 64)
	r := make([]byte, 256)
	t := 0
	e := 0
	for e < len(pubkeyStr) {
		i := tableU32(pubkeyStr[e])
		i = (i << 6) | tableU32Masked(pubkeyStr[e+1])
		i = (i << 6) | tableU32Masked(pubkeyStr[e+2])
		i = (i << 6) | tableU32Masked(pubkeyStr[e+3])
		e += 4
		r[t] = byte((i >> 16) & 255)
		r[t+1] = byte((i >> 8) & 255)
		r[t+2] = byte(i & 255)
		t += 3
	}
	bk.keyToBignum(bk.pubkey.key1[:], r, 64)
	bk.pubkey.len = bk.bitlenBignum(bk.pubkey.key1[:], 64) - 1
}

func (bk *blowfishKey) lenPredata() int {
	e := ((bk.pubkey.len - 1) / 8)
	return (1 + (55 / e)) * (1 + e)
}

func (bk *blowfishKey) cmpBignum(e, t []uint32, i int) int {
	for i > 0 {
		i--
		if e[i] < t[i] {
			return -1
		}
		if e[i] > t[i] {
			return 1
		}
	}
	return 0
}

func (bk *blowfishKey) movBignum(e, t []uint32, i int) {
	for r := 0; r < i; r++ {
		e[r] = t[r]
	}
}

func (bk *blowfishKey) shrBignum(e []uint32, t, i int) {
	s := t / 32
	var r int
	if s > 0 {
		for r = 0; r < i-s; r++ {
			e[r] = e[r+s]
		}
		for ; r < i; r++ {
			e[r] = 0
		}
		t %= 32
	}
	if t != 0 {
		for r = 0; r < i-1; r++ {
			e[r] = (e[r] >> uint(t)) | (e[r+1] << uint(32-t))
		}
		e[r] = e[r] >> uint(t)
	}
}

func (bk *blowfishKey) shlBignum(e []uint32, t, i int) {
	s := t / 32
	var r int
	if s > 0 {
		for r = i - 1; r > s; r-- {
			e[r] = e[r-s]
		}
		for ; r > 0; r-- {
			e[r] = 0
		}
		t %= 32
	}
	if t != 0 {
		for r = i - 1; r > 0; r-- {
			e[r] = (e[r] << uint(t)) | (e[r-1] >> uint(32-t))
		}
		e[0] = e[0] << uint(t)
	}
}

func (bk *blowfishKey) subBignum(e, t, i []uint32, r uint32, s int) uint32 {
	s += s
	h := 0
	for s--; s != -1; s-- {
		a := uint32(getU16(t, h))
		n := uint32(getU16(i, h))
		diff := a - n - r
		setU16(e, h, uint16(diff))
		if diff&0x10000 != 0 {
			r = 1
		} else {
			r = 0
		}
		h++
	}
	return r
}

func (bk *blowfishKey) subBignumWord(e, t, i []uint32, eOff int, r uint32, s int) uint32 {
	o := 0
	for s--; s != -1; s-- {
		a := uint32(getU16(t, eOff+o))
		n := uint32(getU16(i, o))
		diff := a - n - r
		setU16(e, eOff+o, uint16(diff))
		if diff&0x10000 != 0 {
			r = 1
		} else {
			r = 0
		}
		o++
	}
	return r
}

func (bk *blowfishKey) invBignum(e, t []uint32, i int) {
	var r [64]uint32
	bk.initBignum(r[:], 0, i)
	bk.initBignum(e, 0, i)
	n := bk.bitlenBignum(t, i)
	a := uint32(1) << uint(n%32)
	o := ((n + 32) / 32) - 1
	s := uint32(4 * ((n - 1) / 32))
	r[s/4] = r[s/4] | (uint32(1) << uint((n-1)&31))
	for n > 0 {
		n--
		bk.shlBignum(r[:], 1, i)
		if bk.cmpBignum(r[:], t, i) != -1 {
			bk.subBignum(r[:], r[:], t, 0, i)
			e[o] = e[o] | a
		}
		a >>= 1
		if a == 0 {
			o--
			a = 2147483648
		}
	}
	bk.initBignum(r[:], 0, i)
}

func (bk *blowfishKey) incBignum(e []uint32, t int) {
	i := 0
	for {
		e[i]++
		if e[i] != 0 {
			break
		}
		t--
		if t <= 0 {
			break
		}
		i++
	}
}

func (bk *blowfishKey) initTwoDw(e []uint32, t int) {
	bk.movBignum(bk.glob1[:], e, t)
	bk.glob1Bitlen = bk.bitlenBignum(bk.glob1[:], t)
	bk.glob1LenX2 = (bk.glob1Bitlen + 15) / 16
	lenG := bk.lenBignum(bk.glob1[:], t)
	bk.movBignum(bk.glob1Hi[:], bk.glob1[lenG-2:], 2)
	bk.glob1HiBitlen = uint32(bk.bitlenBignum(bk.glob1Hi[:], 2) - 32)
	bk.shrBignum(bk.glob1Hi[:], int(bk.glob1HiBitlen), 2)
	bk.invBignum(bk.glob1HiInv[:], bk.glob1Hi[:], 2)
	bk.shrBignum(bk.glob1HiInv[:], 1, 2)
	bk.glob1HiBitlen = ((bk.glob1HiBitlen + 15) % 16) + 1
	bk.incBignum(bk.glob1HiInv[:], 2)
	if bk.bitlenBignum(bk.glob1HiInv[:], 2) > 32 {
		bk.shrBignum(bk.glob1HiInv[:], 1, 2)
		bk.glob1HiBitlen--
	}
	bk.glob1HiInvLo = bk.glob1HiInv[0] & 65535
	bk.glob1HiInvHi = (bk.glob1HiInv[0] >> 16) & 65535
}

func (bk *blowfishKey) mulBignumWord(e []uint32, eU16Off int, t []uint32, mul uint32, r int) {
	var a uint32
	o := 0
	for s := 0; s < r; s++ {
		a = mul*uint32(getU16(t, o)) + uint32(getU16(e, eU16Off+o)) + a
		setU16(e, eU16Off+o, uint16(a))
		o++
		a >>= 16
	}
	setU16(e, eU16Off+o, getU16(e, eU16Off+o)+uint16(a&65535))
}

func (bk *blowfishKey) mulBignum(e, t, i []uint32, r int) {
	bk.initBignum(e, 0, 2*r)
	o := 0
	for s := 0; s < 2*r; s++ {
		bk.mulBignumWord(e, o, t, uint32(getU16(i, o)), 2*r)
		o++
	}
}

func (bk *blowfishKey) notBignum(e []uint32, t int) {
	for i := 0; i < t; i++ {
		e[i] = ^e[i]
	}
}

func (bk *blowfishKey) negBignum(e []uint32, t int) {
	bk.notBignum(e, t)
	bk.incBignum(e, t)
}

func (bk *blowfishKey) getMulword(e []uint32, t int) uint32 {
	// Faithful port of the TS get_mulword expression (Uint16Array view).
	et1 := uint32(getU16(e, t-1))
	et2 := uint32(getU16(e, t-2))
	et := uint32(getU16(e, t))
	lo := bk.glob1HiInvLo
	hi := bk.glob1HiInvHi
	i := (((((((((65535&(65535^et1))*lo + 65536) >> 1) +
		(((65535^et2)*hi + hi) >> 1) +
		1) >> 16) +
		(((65535 & (65535 ^ et1)) * hi) >> 1) +
		(((65535 ^ et) * lo) >> 1) +
		1) >> 14) +
		hi*(65535^et)*2) >> bk.glob1HiBitlen)
	if i > 65535 {
		i = 65535
	}
	return i & 65535
}

func (bk *blowfishKey) decBignum(e []uint32, t int) {
	i := 0
	for {
		e[i]--
		if e[i] != 0xFFFFFFFF {
			break
		}
		t--
		if t <= 0 {
			break
		}
		i++
	}
}

func (bk *blowfishKey) calcABignum(e, t, i []uint32, r int) {
	n := bk.glob1[:]
	o := bk.glob2[:]
	bk.mulBignum(bk.glob2[:], t, i, r)
	bk.glob2[2*r] = 0
	s := 2 * bk.lenBignum(bk.glob2[:], 2*r+1)
	if s >= bk.glob1LenX2 {
		bk.incBignum(bk.glob2[:], 2*r+1)
		bk.negBignum(bk.glob2[:], 2*r+1)
		a := 1 + s - bk.glob1LenX2
		tt := a
		ii := 1 + s
		for a != 0 {
			a--
			ii--
			l := bk.getMulword(o, ii)
			tt--
			if l > 0 {
				bk.mulBignumWord(o, tt, n, l, 2*r)
				if getU16(o, ii)&32768 == 0 {
					if bk.subBignumWord(o, o, n, tt, 0, 2*r) != 0 {
						// e[i]-- in TS on Uint16Array
						setU16(o, ii, getU16(o, ii)-1)
					}
				}
			}
		}
		bk.negBignum(bk.glob2[:], r)
		bk.decBignum(bk.glob2[:], r)
	}
	bk.movBignum(e, bk.glob2[:], r)
}

func (bk *blowfishKey) clearTmpVars(e int) {
	bk.initBignum(bk.glob1[:], 0, e)
	bk.initBignum(bk.glob2[:], 0, e)
	bk.initBignum(bk.glob1HiInv[:], 0, 4)
	bk.initBignum(bk.glob1Hi[:], 0, 4)
	bk.glob1Bitlen = 0
	bk.glob1HiBitlen = 0
	bk.glob1LenX2 = 0
	bk.glob1HiInvLo = 0
	bk.glob1HiInvHi = 0
}

func (bk *blowfishKey) calcAKey(e, t, i, r []uint32, s int) {
	var o [64]uint32
	bk.initBignum(e, 1, s)
	n := bk.lenBignum(r, s)
	bk.initTwoDw(r, n)
	// (bitlen << 24) >> 24 — sign-extend low 8 bits like JS
	l := int(int8(uint8(bk.bitlenBignum(i, n))))
	a := uint32(((l + 31) / 32))
	c := (uint32(1) << uint((l-1)%32)) >> 1
	h := int(a - 1)
	l--
	bk.movBignum(e, t, n)
	for {
		l--
		if l == -1 {
			break
		}
		if c == 0 {
			c = 2147483648
			h--
		}
		bk.calcABignum(o[:], e, e, n)
		if i[h]&c != 0 {
			bk.calcABignum(e, o[:], t, n)
		} else {
			bk.movBignum(e, o[:], n)
		}
		c >>= 1
	}
	bk.initBignum(o[:], 0, n)
	bk.clearTmpVars(s)
}

func memcpyBytes(dst, src []byte, n int) {
	copy(dst[:n], src[:n])
}

func (bk *blowfishKey) processPredata(e []byte, t int, out []byte) {
	var r, s [64]uint32
	a := 0
	n := 0
	o := (bk.pubkey.len - 1) / 8
	for 1+o <= t {
		bk.initBignum(r[:], 0, 64)
		writeBytesIntoWords(r[:], e[a:a+1+o])
		bk.calcAKey(s[:], r[:], bk.pubkey.key2[:], bk.pubkey.key1[:], 64)
		sb := wordsAsBytes(s[:])
		memcpyBytes(out[n:], sb, o)
		t -= 1 + o
		a += 1 + o
		n += o
	}
}

func (bk *blowfishKey) decryptKey(e []byte) []byte {
	bk.initPubkey()
	t := make([]byte, 256)
	bk.processPredata(e, bk.lenPredata(), t)
	out := make([]byte, 56)
	copy(out, t[:56])
	return out
}
