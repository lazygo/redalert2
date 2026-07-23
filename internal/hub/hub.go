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
	h.leaveRoom(c, "disconnect")
	h.mu.Lock()
	delete(h.clients, c.id)
	h.mu.Unlock()
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
	empty, _, _ := room.Remove(c.id)
	c.roomID = ""
	peer := c.PeerInfo()
	if empty {
		h.mu.Lock()
		delete(h.rooms, roomID)
		h.mu.Unlock()
	} else {
		info := room.Info()
		room.Broadcast("", protocol.Envelope{
			Type:   protocol.TypeMemberLeave,
			Member: &peer,
			Reason: reason,
			Room:   &info,
		})
	}
	c.SendJSON(protocol.Envelope{Type: protocol.TypeRoomLeft, RoomID: roomID, Reason: reason})
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
