package protocol

// Client -> server message types.
const (
	TypeHello          = "hello"
	TypeListRooms      = "list-rooms"
	TypeCreateRoom     = "create-room"
	TypeJoinRoom       = "join-room"
	TypeLeaveRoom      = "leave-room"
	TypeUpdateRoom     = "update-room"
	TypeRoomBroadcast  = "room-broadcast"
	TypeRoomSend       = "room-send"
	TypeStartMatch     = "start-match"
	TypePing           = "ping"
)

// Server -> client message types.
const (
	TypeWelcome     = "welcome"
	TypeRoomList    = "room-list"
	TypeRoomJoined  = "room-joined"
	TypeRoomLeft    = "room-left"
	TypeMemberJoin  = "member-join"
	TypeMemberLeave = "member-leave"
	TypeRelay       = "relay"
	TypeError       = "error"
	TypePong        = "pong"
)

const (
	RoomStatusOpen    = "open"
	RoomStatusStarted = "started"
)

type Envelope struct {
	Type string `json:"type"`

	// hello
	Nickname string `json:"nickname,omitempty"`

	// create-room / update-room
	Title      string `json:"title,omitempty"`
	MaxPlayers int    `json:"maxPlayers,omitempty"`
	MapName    string `json:"mapName,omitempty"`
	Public     *bool  `json:"public,omitempty"`

	// join-room
	RoomID string `json:"roomId,omitempty"`

	// room-send
	ToPeerID string `json:"toPeerId,omitempty"`

	// room-broadcast / room-send / relay
	Payload any `json:"payload,omitempty"`

	// welcome
	PeerID string `json:"peerId,omitempty"`

	// room-list / room-joined
	Rooms []RoomInfo `json:"rooms,omitempty"`
	Room  *RoomInfo  `json:"room,omitempty"`

	// member-join / member-leave / relay
	Member *PeerInfo `json:"member,omitempty"`
	From   *PeerInfo `json:"from,omitempty"`
	Reason string    `json:"reason,omitempty"`

	// error
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

type PeerInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type RoomInfo struct {
	RoomID      string `json:"roomId"`
	Title       string `json:"title"`
	HostName    string `json:"hostName"`
	HostPeerID  string `json:"hostPeerId"`
	PlayerCount int    `json:"playerCount"`
	MaxPlayers  int    `json:"maxPlayers"`
	MapName     string `json:"mapName,omitempty"`
	Status      string `json:"status"`
	Public      bool   `json:"public"`
}
