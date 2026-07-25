package hub

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/ra2web/redalert2/internal/protocol"
)

type Hub struct {
	mu      sync.RWMutex
	clients map[string]*Client
	rooms   map[string]*Room
}

func New() *Hub {
	return &Hub{
		clients: make(map[string]*Client),
		rooms:   make(map[string]*Room),
	}
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}
	id := newID()
	client := NewClient(h, conn, id)
	h.mu.Lock()
	h.clients[id] = client
	h.mu.Unlock()

	go client.writePump()
	go client.readPump()
}

func (h *Hub) unregister(c *Client) {
	h.detachOrLeave(c)
	h.mu.Lock()
	delete(h.clients, c.id)
	h.mu.Unlock()
}

func (h *Hub) detachOrLeave(c *Client) {
	roomID := c.roomID
	if roomID == "" {
		return
	}
	h.mu.RLock()
	room, ok := h.rooms[roomID]
	h.mu.RUnlock()
	if !ok {
		c.roomID = ""
		return
	}
	if room.Status() == protocol.RoomStatusStarted && room.DetachDuringMatch(c, MatchReconnectGrace) {
		peer := protocol.PeerInfo{ID: c.id, Name: c.name}
		c.roomID = ""
		info := room.Info()
		room.Broadcast("", protocol.Envelope{
			Type:   protocol.TypeMemberLeave,
			Member: &peer,
			Reason: "disconnecting",
			Room:   &info,
		})
		go h.finalizeDetachAfterGrace(roomID, peer.ID, MatchReconnectGrace)
		return
	}
	h.leaveRoom(c, "disconnect")
}

func (h *Hub) finalizeDetachAfterGrace(roomID, peerID string, grace time.Duration) {
	timer := time.NewTimer(grace)
	defer timer.Stop()
	<-timer.C

	h.mu.RLock()
	room, ok := h.rooms[roomID]
	h.mu.RUnlock()
	if !ok || !room.HasDetached(peerID) {
		return
	}
	seat := room.ClearDetached(peerID)
	if seat == nil {
		return
	}

	peer := protocol.PeerInfo{ID: peerID, Name: seat.Name}
	empty := false
	wasHost := seat.WasHost
	h.mu.RLock()
	_, roomStillExists := h.rooms[roomID]
	h.mu.RUnlock()
	if !roomStillExists {
		return
	}

	// Count remaining after clearing this detached seat.
	infoBefore := room.Info()
	empty = infoBefore.PlayerCount == 0
	if empty {
		h.mu.Lock()
		delete(h.rooms, roomID)
		h.mu.Unlock()
		h.broadcastRoomList()
		return
	}

	if wasHost {
		remaining := room.DrainMembers()
		h.mu.Lock()
		delete(h.rooms, roomID)
		h.mu.Unlock()
		for _, member := range remaining {
			member.roomID = ""
			member.SendJSON(protocol.Envelope{
				Type:   protocol.TypeRoomLeft,
				RoomID: roomID,
				Reason: "host_disconnect",
				Member: &peer,
			})
		}
		h.broadcastRoomList()
		return
	}

	info := room.Info()
	room.Broadcast("", protocol.Envelope{
		Type:   protocol.TypeMemberLeave,
		Member: &peer,
		Reason: "disconnect",
		Room:   &info,
	})
	h.broadcastRoomList()
}

func (h *Hub) handleMessage(c *Client, env *protocol.Envelope) {
	switch env.Type {
	case protocol.TypeHello:
		h.handleHello(c, env)
	case protocol.TypeListRooms:
		h.sendRoomList(c)
	case protocol.TypeCreateRoom:
		h.handleCreateRoom(c, env)
	case protocol.TypeJoinRoom:
		h.handleJoinRoom(c, env)
	case protocol.TypeLeaveRoom:
		h.leaveRoom(c, "left")
	case protocol.TypeUpdateRoom:
		h.handleUpdateRoom(c, env)
	case protocol.TypeRoomBroadcast:
		h.handleBroadcast(c, env)
	case protocol.TypeRoomSend:
		h.handleSend(c, env)
	case protocol.TypeStartMatch:
		h.handleStartMatch(c)
	case protocol.TypePing:
		c.SendJSON(protocol.Envelope{Type: protocol.TypePong})
	default:
		c.SendJSON(protocol.Envelope{Type: protocol.TypeError, Code: "unknown_type", Message: "unknown message type: " + env.Type})
	}
}

func (h *Hub) handleHello(c *Client, env *protocol.Envelope) {
	name := sanitizeName(env.Nickname)
	if name == "" {
		c.SendJSON(protocol.Envelope{Type: protocol.TypeError, Code: "bad_nickname", Message: "nickname required"})
		return
	}

	if env.ResumePeerID != "" && env.RoomID != "" {
		if h.tryResumeMatch(c, env.RoomID, env.ResumePeerID, name) {
			return
		}
		c.SendJSON(protocol.Envelope{
			Type:    protocol.TypeError,
			Code:    "resume_failed",
			Message: "unable to resume match seat",
		})
	}

	c.mu.Lock()
	c.name = name
	c.helloed = true
	c.mu.Unlock()
	c.SendJSON(protocol.Envelope{
		Type:   protocol.TypeWelcome,
		PeerID: c.id,
		Member: &protocol.PeerInfo{ID: c.id, Name: name},
	})
	h.sendRoomList(c)
}

// tryResumeMatch reassigns this connection to a detached started-match seat.
func (h *Hub) tryResumeMatch(c *Client, roomID, peerID, name string) bool {
	h.mu.Lock()
	room, ok := h.rooms[roomID]
	if !ok {
		h.mu.Unlock()
		return false
	}
	if !room.HasDetached(peerID) {
		h.mu.Unlock()
		return false
	}
	oldID := c.id
	delete(h.clients, oldID)
	c.id = peerID
	c.name = name
	c.helloed = true
	c.roomID = roomID
	h.clients[peerID] = c
	h.mu.Unlock()

	if !room.TryReattach(c) {
		h.mu.Lock()
		delete(h.clients, peerID)
		c.id = oldID
		c.roomID = ""
		c.helloed = false
		h.clients[oldID] = c
		h.mu.Unlock()
		return false
	}

	info := room.Info()
	peer := c.PeerInfo()
	c.SendJSON(protocol.Envelope{
		Type:   protocol.TypeWelcome,
		PeerID: peer.ID,
		Member: &peer,
	})
	c.SendJSON(protocol.Envelope{Type: protocol.TypeRoomJoined, Room: &info})
	room.Broadcast(c.id, protocol.Envelope{
		Type:   protocol.TypeMemberJoin,
		Member: &peer,
		Reason: "reconnected",
		Room:   &info,
	})
	for _, m := range room.MemberList() {
		if m.ID == c.id {
			continue
		}
		mm := m
		c.SendJSON(protocol.Envelope{Type: protocol.TypeMemberJoin, Member: &mm, Room: &info})
	}
	return true
}

func (h *Hub) requireHello(c *Client) bool {
	c.mu.Lock()
	ok := c.helloed
	c.mu.Unlock()
	if !ok {
		c.SendJSON(protocol.Envelope{Type: protocol.TypeError, Code: "not_helloed", Message: "send hello first"})
	}
	return ok
}

func (h *Hub) handleCreateRoom(c *Client, env *protocol.Envelope) {
	if !h.requireHello(c) {
		return
	}
	if c.roomID != "" {
		c.SendJSON(protocol.Envelope{Type: protocol.TypeError, Code: "already_in_room", Message: "leave current room first"})
		return
	}
	title := sanitizeName(env.Title)
	if title == "" {
		title = c.name + "'s room"
	}
	public := true
	if env.Public != nil {
		public = *env.Public
	}
	roomID := newID()
	room := NewRoom(roomID, title, c.id, env.MaxPlayers, public)
	if env.MapName != "" {
		room.UpdateMeta("", env.MapName, 0, nil)
	}
	if !room.Add(c) {
		c.SendJSON(protocol.Envelope{Type: protocol.TypeError, Code: "create_failed", Message: "failed to create room"})
		return
	}
	c.roomID = roomID
	h.mu.Lock()
	h.rooms[roomID] = room
	h.mu.Unlock()

	info := room.Info()
	c.SendJSON(protocol.Envelope{Type: protocol.TypeRoomJoined, Room: &info})
	h.broadcastRoomList()
}

func (h *Hub) handleJoinRoom(c *Client, env *protocol.Envelope) {
	if !h.requireHello(c) {
		return
	}
	if c.roomID != "" {
		c.SendJSON(protocol.Envelope{Type: protocol.TypeError, Code: "already_in_room", Message: "leave current room first"})
		return
	}
	h.mu.RLock()
	room, ok := h.rooms[env.RoomID]
	h.mu.RUnlock()
	if !ok {
		c.SendJSON(protocol.Envelope{Type: protocol.TypeError, Code: "room_not_found", Message: "room not found"})
		return
	}
	info := room.Info()
	if info.Status != protocol.RoomStatusOpen {
		c.SendJSON(protocol.Envelope{Type: protocol.TypeError, Code: "room_started", Message: "game already started"})
		return
	}
	if !room.Add(c) {
		c.SendJSON(protocol.Envelope{Type: protocol.TypeError, Code: "room_full", Message: "room is full"})
		return
	}
	c.roomID = room.id
	peer := c.PeerInfo()
	room.Broadcast(c.id, protocol.Envelope{
		Type:   protocol.TypeMemberJoin,
		Member: &peer,
		Room:   ptrInfo(room.Info()),
	})
	joined := room.Info()
	c.SendJSON(protocol.Envelope{Type: protocol.TypeRoomJoined, Room: &joined})
	// Also send existing members to joiner as member-join events for convenience.
	for _, m := range room.MemberList() {
		if m.ID == c.id {
			continue
		}
		mm := m
		c.SendJSON(protocol.Envelope{Type: protocol.TypeMemberJoin, Member: &mm, Room: &joined})
	}
	h.broadcastRoomList()
}

func (h *Hub) leaveRoom(c *Client, reason string) {
	roomID := c.roomID
	if roomID == "" {
		return
	}
	h.mu.Lock()
	room, ok := h.rooms[roomID]
	h.mu.Unlock()
	if !ok {
		c.roomID = ""
		return
	}

	empty, wasHost, _ := room.Remove(c.id)
	c.roomID = ""
	peer := c.PeerInfo()

	leftReason := reason
	if wasHost {
		if reason == "disconnect" {
			leftReason = "host_disconnect"
		} else {
			leftReason = "host_left"
		}
	}

	if empty {
		h.mu.Lock()
		delete(h.rooms, roomID)
		h.mu.Unlock()
	} else if wasHost {
		// Host left/disconnected → dissolve room; everyone must leave.
		remaining := room.DrainMembers()
		h.mu.Lock()
		delete(h.rooms, roomID)
		h.mu.Unlock()
		for _, member := range remaining {
			member.roomID = ""
			member.SendJSON(protocol.Envelope{
				Type:   protocol.TypeRoomLeft,
				RoomID: roomID,
				Reason: leftReason,
				Member: &peer,
			})
		}
	} else {
		info := room.Info()
		room.Broadcast("", protocol.Envelope{
			Type:   protocol.TypeMemberLeave,
			Member: &peer,
			Reason: reason,
			Room:   &info,
		})
	}

	c.SendJSON(protocol.Envelope{Type: protocol.TypeRoomLeft, RoomID: roomID, Reason: leftReason})
	h.broadcastRoomList()
}

func (h *Hub) handleUpdateRoom(c *Client, env *protocol.Envelope) {
	if !h.requireHello(c) || c.roomID == "" {
		return
	}
	h.mu.RLock()
	room, ok := h.rooms[c.roomID]
	h.mu.RUnlock()
	if !ok {
		return
	}
	info := room.Info()
	if info.HostPeerID != c.id {
		c.SendJSON(protocol.Envelope{Type: protocol.TypeError, Code: "not_host", Message: "only host can update room"})
		return
	}
	room.UpdateMeta(env.Title, env.MapName, env.MaxPlayers, env.Public)
	h.broadcastRoomList()
}

func (h *Hub) handleBroadcast(c *Client, env *protocol.Envelope) {
	if !h.requireHello(c) || c.roomID == "" {
		return
	}
	h.mu.RLock()
	room, ok := h.rooms[c.roomID]
	h.mu.RUnlock()
	if !ok {
		return
	}
	from := c.PeerInfo()
	room.Broadcast(c.id, protocol.Envelope{
		Type:    protocol.TypeRelay,
		From:    &from,
		Payload: env.Payload,
		RoomID:  c.roomID,
	})
}

func (h *Hub) handleSend(c *Client, env *protocol.Envelope) {
	if !h.requireHello(c) || c.roomID == "" {
		return
	}
	h.mu.RLock()
	room, ok := h.rooms[c.roomID]
	h.mu.RUnlock()
	if !ok {
		return
	}
	from := c.PeerInfo()
	okSend := room.SendTo(env.ToPeerID, protocol.Envelope{
		Type:    protocol.TypeRelay,
		From:    &from,
		Payload: env.Payload,
		RoomID:  c.roomID,
	})
	if !okSend {
		c.SendJSON(protocol.Envelope{Type: protocol.TypeError, Code: "peer_not_found", Message: "target peer not in room"})
	}
}

func (h *Hub) handleStartMatch(c *Client) {
	if !h.requireHello(c) || c.roomID == "" {
		return
	}
	h.mu.RLock()
	room, ok := h.rooms[c.roomID]
	h.mu.RUnlock()
	if !ok {
		return
	}
	info := room.Info()
	if info.HostPeerID != c.id {
		c.SendJSON(protocol.Envelope{Type: protocol.TypeError, Code: "not_host", Message: "only host can start match"})
		return
	}
	room.MarkStarted()
	h.broadcastRoomList()
}

func (h *Hub) sendRoomList(c *Client) {
	c.SendJSON(protocol.Envelope{Type: protocol.TypeRoomList, Rooms: h.listPublicRooms()})
}

func (h *Hub) broadcastRoomList() {
	rooms := h.listPublicRooms()
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.clients {
		if !c.helloed {
			continue
		}
		c.SendJSON(protocol.Envelope{Type: protocol.TypeRoomList, Rooms: rooms})
	}
}

func (h *Hub) listPublicRooms() []protocol.RoomInfo {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]protocol.RoomInfo, 0)
	for _, room := range h.rooms {
		info := room.Info()
		if info.Public && info.Status == protocol.RoomStatusOpen {
			out = append(out, info)
		}
	}
	return out
}

func ptrInfo(info protocol.RoomInfo) *protocol.RoomInfo {
	return &info
}

func sanitizeName(s string) string {
	runes := []rune(s)
	if len(runes) > 24 {
		runes = runes[:24]
	}
	out := make([]rune, 0, len(runes))
	for _, r := range runes {
		if r == '\n' || r == '\r' || r == '\t' {
			continue
		}
		out = append(out, r)
	}
	return string(out)
}

func newID() string {
	return time.Now().UTC().Format("20060102150405") + "-" + randomHex(8)
}

func randomHex(nBytes int) string {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return hex.EncodeToString([]byte(time.Now().Format("150405.000")))
	}
	return hex.EncodeToString(b)
}
