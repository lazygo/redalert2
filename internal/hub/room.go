package hub

import (
	"sync"

	"github.com/ra2web/redalert2/internal/protocol"
)

type Room struct {
	mu         sync.RWMutex
	id         string
	title      string
	hostPeerID string
	maxPlayers int
	mapName    string
	status     string
	public     bool
	members    map[string]*Client // peerId -> client
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
	}
}

func (r *Room) Info() protocol.RoomInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	hostName := ""
	if host, ok := r.members[r.hostPeerID]; ok {
		hostName = host.name
	}
	return protocol.RoomInfo{
		RoomID:      r.id,
		Title:       r.title,
		HostName:    hostName,
		HostPeerID:  r.hostPeerID,
		PlayerCount: len(r.members),
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

func (r *Room) Add(c *Client) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.status != protocol.RoomStatusOpen {
		return false
	}
	if len(r.members) >= r.maxPlayers {
		return false
	}
	r.members[c.id] = c
	return true
}

func (r *Room) Remove(peerID string) (empty bool, wasHost bool, nextHost string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.members[peerID]
	if !ok {
		return len(r.members) == 0, false, ""
	}
	delete(r.members, peerID)
	wasHost = r.hostPeerID == peerID
	if wasHost && len(r.members) > 0 {
		for id := range r.members {
			r.hostPeerID = id
			nextHost = id
			break
		}
	}
	return len(r.members) == 0, wasHost, nextHost
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
