package hub

import (
	"sync"
	"time"

	"github.com/ra2web/redalert2/internal/protocol"
)

const MatchReconnectGrace = 45 * time.Second

type DetachedSeat struct {
	Name     string
	Deadline time.Time
	WasHost  bool
}

type Room struct {
	mu         sync.RWMutex
	id         string
	title      string
	hostPeerID string
	maxPlayers int
	mapName    string
	status     string
	public     bool
	members    map[string]*Client // peerId -> live client
	detached   map[string]*DetachedSeat
}

func NewRoom(id, title, hostPeerID string, maxPlayers int, public bool) *Room {
	if maxPlayers <= 0 {
		maxPlayers = 8
	}
	if maxPlayers > 8 {
		maxPlayers = 8
	}
	return &Room{
		id:         id,
		title:      title,
		hostPeerID: hostPeerID,
		maxPlayers: maxPlayers,
		status:     protocol.RoomStatusOpen,
		public:     public,
		members:    make(map[string]*Client),
		detached:   make(map[string]*DetachedSeat),
	}
}

func (r *Room) Info() protocol.RoomInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	hostName := ""
	if host, ok := r.members[r.hostPeerID]; ok {
		hostName = host.name
	} else if seat, ok := r.detached[r.hostPeerID]; ok {
		hostName = seat.Name
	}
	return protocol.RoomInfo{
		RoomID:      r.id,
		Title:       r.title,
		HostName:    hostName,
		HostPeerID:  r.hostPeerID,
		PlayerCount: len(r.members) + len(r.detached),
		MaxPlayers:  r.maxPlayers,
		MapName:     r.mapName,
		Status:      r.status,
		Public:      r.public,
	}
}

func (r *Room) MemberList() []protocol.PeerInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]protocol.PeerInfo, 0, len(r.members))
	for _, c := range r.members {
		out = append(out, c.PeerInfo())
	}
	return out
}

func (r *Room) Status() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.status
}

func (r *Room) Add(c *Client) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.status != protocol.RoomStatusOpen {
		return false
	}
	if len(r.members)+len(r.detached) >= r.maxPlayers {
		return false
	}
	r.members[c.id] = c
	return true
}

func (r *Room) Remove(peerID string) (empty bool, wasHost bool, nextHost string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, inLive := r.members[peerID]
	_, inDetached := r.detached[peerID]
	if !inLive && !inDetached {
		return len(r.members)+len(r.detached) == 0, false, ""
	}
	delete(r.members, peerID)
	delete(r.detached, peerID)
	wasHost = r.hostPeerID == peerID
	if wasHost && len(r.members) > 0 {
		for id := range r.members {
			r.hostPeerID = id
			nextHost = id
			break
		}
	}
	return len(r.members)+len(r.detached) == 0, wasHost, nextHost
}

// DetachDuringMatch parks a started-match seat so the peer can resume with the same id.
func (r *Room) DetachDuringMatch(c *Client, grace time.Duration) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.status != protocol.RoomStatusStarted {
		return false
	}
	if _, ok := r.members[c.id]; !ok {
		return false
	}
	delete(r.members, c.id)
	r.detached[c.id] = &DetachedSeat{
		Name:     c.name,
		Deadline: time.Now().Add(grace),
		WasHost:  r.hostPeerID == c.id,
	}
	return true
}

// TryReattach resumes a detached seat onto a live connection (same peer id).
func (r *Room) TryReattach(c *Client) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	seat, ok := r.detached[c.id]
	if !ok {
		return false
	}
	if time.Now().After(seat.Deadline) {
		delete(r.detached, c.id)
		return false
	}
	delete(r.detached, c.id)
	r.members[c.id] = c
	return true
}

func (r *Room) HasDetached(peerID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.detached[peerID]
	return ok
}

func (r *Room) ClearDetached(peerID string) *DetachedSeat {
	r.mu.Lock()
	defer r.mu.Unlock()
	seat := r.detached[peerID]
	delete(r.detached, peerID)
	return seat
}

// DrainMembers returns remaining live clients and clears membership (including detached).
func (r *Room) DrainMembers() []*Client {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*Client, 0, len(r.members))
	for _, c := range r.members {
		out = append(out, c)
	}
	r.members = make(map[string]*Client)
	r.detached = make(map[string]*DetachedSeat)
	return out
}

func (r *Room) Broadcast(exceptPeerID string, env protocol.Envelope) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for id, c := range r.members {
		if id == exceptPeerID {
			continue
		}
		c.SendJSON(env)
	}
}

func (r *Room) SendTo(peerID string, env protocol.Envelope) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	c, ok := r.members[peerID]
	if !ok {
		return false
	}
	c.SendJSON(env)
	return true
}

func (r *Room) MarkStarted() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.status = protocol.RoomStatusStarted
	r.public = false
}

func (r *Room) UpdateMeta(title, mapName string, maxPlayers int, public *bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if title != "" {
		r.title = title
	}
	if mapName != "" {
		r.mapName = mapName
	}
	if maxPlayers > 0 {
		if maxPlayers > 8 {
			maxPlayers = 8
		}
		r.maxPlayers = maxPlayers
	}
	if public != nil && r.status == protocol.RoomStatusOpen {
		r.public = *public
	}
}
