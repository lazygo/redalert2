package hub

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/ra2web/redalert2/internal/protocol"
)

const (
	writeWait      = 10 * time.Second
	pingPeriod     = 25 * time.Second
	maxMessageSize = 8 << 20 // 8 MiB for map chunks
)

type Client struct {
	hub     *Hub
	conn    *websocket.Conn
	send    chan []byte
	id      string
	name    string
	roomID  string
	helloed bool
	mu      sync.Mutex
	closed  bool
	ctx     context.Context
	cancel  context.CancelFunc
}

func NewClient(hub *Hub, conn *websocket.Conn, id string) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		hub:    hub,
		conn:   conn,
		send:   make(chan []byte, 64),
		id:     id,
		ctx:    ctx,
		cancel: cancel,
	}
}

func (c *Client) PeerInfo() protocol.PeerInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	return protocol.PeerInfo{ID: c.id, Name: c.name}
}

func (c *Client) SendJSON(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("marshal error: %v", err)
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	select {
	case c.send <- data:
	default:
		log.Printf("client %s send buffer full, dropping message", c.id)
	}
}

func (c *Client) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.mu.Unlock()
	c.cancel()
	_ = c.conn.Close(websocket.StatusNormalClosure, "")
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister(c)
		c.Close()
	}()
	c.conn.SetReadLimit(maxMessageSize)
	for {
		_, data, err := c.conn.Read(c.ctx)
		if err != nil {
			return
		}
		var env protocol.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			c.SendJSON(protocol.Envelope{Type: protocol.TypeError, Code: "bad_json", Message: "invalid JSON"})
			continue
		}
		c.hub.handleMessage(c, &env)
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case message := <-c.send:
			writeCtx, cancel := context.WithTimeout(context.Background(), writeWait)
			err := c.conn.Write(writeCtx, websocket.MessageText, message)
			cancel()
			if err != nil {
				return
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(context.Background(), writeWait)
			err := c.conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}
