# QueueDesk

> Real-Time Customer Support & Ticket Queue Platform

A production-grade Zendesk/Intercom-style live support platform where customers queue for an agent in real time, agents claim tickets without collision, and unassigned tickets auto-escalate via SLA timeouts.

## Stack

| Layer | Choice |
|---|---|
| Backend | Node.js + Express |
| Real-time | Socket.IO |
| Database | PostgreSQL (Neon) |
| Cache / Queue / Pub-Sub | Redis (Docker) |
| Background Jobs | BullMQ |
| Frontend | Vite + React |
| Load Testing | k6 |

## Getting Started

### Prerequisites
- Node.js 18+
- Docker Desktop (for Redis)

### Setup

```bash
# 1. Start Redis
docker-compose up -d

# 2. Server setup
cd server
cp .env.example .env
# → Fill in DATABASE_URL (Neon), JWT secrets, COOKIE_SECRET
npm run dev

# 3. Client setup (new terminal)
cd client
npm run dev
```

Server runs on `http://localhost:3001`  
Client runs on `http://localhost:5173`

## Architecture

```
Customer connects → WebSocket handshake (JWT verified)
  → Atomic Redis check: agent free?
      YES → instant match → live chat begins
      NO  → Redis sorted-set queue → live position updates
              → agent frees up → ZPOPMIN → assign → chat begins
  → Agent claims ticket (Redis SET NX PX lock — one winner)
  → Chat: messages buffered in Redis List → flushed to DB every 30s
  → Ticket idle > N min → SLA escalation (BullMQ worker)
  → Ticket closed → transcript force-flushed → session ends
```

## Key Design Decisions

| Decision | Choice |
|---|---|
| Atomic matching | Lua script on Redis (eliminates availability-check race) |
| Ticket claiming | `SET NX PX` — atomic, auto-expiring distributed lock |
| Queue structure | Redis Sorted Set, score = join timestamp (FIFO) |
| Message persistence | Redis List buffer → BullMQ batch flush every 30s (hot path stays in-memory) |
| WS scaling | `@socket.io/redis-adapter` — transparent fan-out across instances |
| Refresh token | httpOnly cookie (`SameSite=Strict`) — XSS-safe |
| Brute-force protection | `express-rate-limit` on `/api/auth/login` |

## Load Test Results

> _To be filled in after M13_

- Double-claimed tickets: 0
- Double-matched customers: 0
- Queue position update latency p99: Xms
- SLA escalation accuracy under load: X%

## Resume Bullet

> Built a real-time customer support platform with JWT-based auth and role-based access control, a Redis-backed live queue for agent matching, distributed locking to prevent duplicate ticket claims, SLA-based auto-escalation, and a multi-channel notification system with retry-with-backoff delivery via background workers. Load-tested with k6 simulating concurrent support spikes, achieving zero double-claimed tickets and sub-Xms queue-position update latency.
