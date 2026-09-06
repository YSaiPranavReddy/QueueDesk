# QueueDesk — Full Implementation Plan

## Project Overview

**QueueDesk** is a production-grade real-time customer support & ticket queue platform — a Zendesk/Intercom-style system where customers queue for live agents, agents claim tickets without collision, and SLA timeouts auto-escalate stale tickets. The project is designed to demonstrate backend engineering depth: distributed locking, atomic Redis operations, WebSocket scaling via pub/sub, and background job reliability.

---

## Stack

| Layer | Choice | Rationale |
|---|---|---|
| **Backend** | Node.js + Express | Fast to iterate, Socket.IO native, ecosystem alignment |
| **Real-time** | Socket.IO | Rooms, namespaces, reconnection baked in |
| **Database** | PostgreSQL via **Neon** | Free serverless tier, no infra to manage |
| **Cache / Queue / Pub-Sub** | **Redis (Docker)** | Full control, Lua scripts, BullMQ, pub/sub all in one |
| **Background Jobs** | BullMQ | Built on Redis, retry/backoff, DLQ support |
| **Auth** | JWT (access + refresh) + bcrypt | Role-based, authenticated WS handshake |
| **Frontend** | **Vite + React** | SPA, Vite dev server, clean separation from backend |
| **Notifications** | Nodemailer (dev SMTP) / SendGrid (prod) | Email first, SMS optional |
| **Load Testing** | k6 (ws module) | WebSocket load test support |
| **Deploy** | Oracle Cloud Free Tier | Backend + Redis; Neon stays managed |

---

## Repo Structure

```
QueueDesk/
├── server/              # Node.js + Express + Socket.IO backend
│   ├── src/
│   │   ├── config/      # DB, Redis, env
│   │   ├── middleware/  # auth, RBAC, error handling
│   │   ├── models/      # DB query functions
│   │   ├── routes/      # REST API routes
│   │   ├── socket/      # Socket.IO event handlers
│   │   ├── queue/       # BullMQ workers & job definitions
│   │   ├── services/    # Business logic (matching, locking, notifications)
│   │   └── index.js
│   ├── .env.example
│   └── package.json
├── client/              # Vite + React frontend
│   ├── src/
│   │   ├── components/  # UI components
│   │   ├── pages/       # Customer, Agent, Admin views
│   │   ├── hooks/       # useSocket, useAuth, etc.
│   │   └── App.jsx
│   └── package.json
├── load-tests/          # k6 scripts
├── docker-compose.yml   # Redis + (optional) local pg
├── QueueDesk_ProjectSpecs.md
└── README.md
```

---

## Phases & Milestones

---

### 🔷 Phase 1 — Foundation (Milestones 1–2)
*Auth, RBAC, Data Model, REST API*

#### Milestone 1 — Auth & RBAC
> **Goal**: Secure login/register for all three roles; authenticated WebSocket handshake.

- [ ] **M1.T1** — Project scaffolding
  - Init `server/` with Express, dotenv, nodemon
  - Init `client/` with Vite + React
  - `docker-compose.yml` for Redis
  - `.env.example` with all required keys
- [ ] **M1.T2** — Database setup
  - Connect to Neon via `pg` / `postgres` driver
  - Schema: `users` table (id, email, password_hash, role: customer/agent/admin, created_at)
  - Migration file (`schema.sql`)
- [ ] **M1.T3** — Auth REST endpoints
  - `POST /api/auth/register` — create user with role
  - `POST /api/auth/login` — bcrypt verify, issue access + refresh JWT
  - `POST /api/auth/refresh` — rotate refresh token
  - `POST /api/auth/logout` — invalidate refresh token (Redis blacklist or DB)
- [ ] **M1.T4** — Auth middleware
  - `authenticateToken` middleware (verify JWT, attach `req.user`)
  - `requireRole(...roles)` middleware for RBAC
- [ ] **M1.T5** — Authenticated WebSocket handshake
  - Socket.IO middleware: extract token from `handshake.auth.token`, verify before allowing connection
  - Reject connections with invalid/expired tokens immediately
- [ ] **M1.T6** — Login rate limiter
  - `express-rate-limit` on `POST /api/auth/login` — e.g. 10 attempts / 15 min per IP
  - Returns `429 Too Many Requests` with `Retry-After` header
  - Cheap to add now, clean interview answer to "how do you prevent brute-force?"
- [ ] **M1.T7** — Frontend: Auth UI
  - Login / Register page (role selector: customer / agent)
  - Access token stored in memory (React state / context) — never in localStorage
  - Refresh token stored in **httpOnly cookie** (XSS-safe; `SameSite=Strict`, `Secure` in prod)
  - Silent refresh: on 401, call `/api/auth/refresh` (cookie sent automatically) → retry original request
  - Auth context + protected routes

#### Milestone 2 — Data Model & REST API
> **Goal**: Full CRUD for the core entities; Postman/REST-testable before any WebSocket work.

- [ ] **M2.T1** — Schema: tickets, messages
  ```sql
  tickets(id, customer_id, agent_id, status, priority, created_at, assigned_at, closed_at, sla_deadline)
  messages(id, ticket_id, sender_id, body, sent_at, read_at)
  ```
- [ ] **M2.T2** — Ticket REST API
  - `POST /api/tickets` — customer creates ticket (triggers queue/match logic later)
  - `GET /api/tickets` — agent/admin lists tickets (filter by status)
  - `GET /api/tickets/:id` — get ticket + messages (auth: assigned agent or admin only)
  - `PATCH /api/tickets/:id/close` — close ticket
- [ ] **M2.T3** — Message REST API
  - `GET /api/tickets/:id/messages` — fetch message history (reconnect use-case)
- [ ] **M2.T4** — Agent status REST API
  - `PATCH /api/agents/status` — set self as available/busy/offline
  - `GET /api/agents` — admin: list all agents with current status
- [ ] **M2.T5** — Frontend: Skeleton views
  - Customer: "Submit ticket" form
  - Agent: Ticket list dashboard (no real-time yet)
  - Admin: Agent list view

---

### 🔷 Phase 2 — The Core Hard Problems (Milestones 3–6)
*Matching, Queue, Locking, Real-time Chat*

#### Milestone 3 — Matching Logic (Atomic Fast Path + Queue Fallback)
> **Goal**: The hardest algorithmic piece — correct, race-free agent matching.

- [ ] **M3.T1** — Redis setup & agent availability layer
  - Redis client setup (ioredis)
  - `agent:status:{agentId}` — hash: `{ status: available|busy|offline }`
  - `agents:available` — Redis Set of available agent IDs
- [ ] **M3.T2** — Lua script: atomic availability check + claim
  ```lua
  -- Atomically: SPOP agents:available → if member exists, set agent busy, return agentId
  -- Else: ZADD queue:{role} timestamp customerId → return queue position
  ```
  - This single script eliminates the race where two customers both see the same agent as free
- [ ] **M3.T3** — Matching service
  - `matchOrEnqueue(customerId)` — runs Lua script, returns `{ matched: true, agentId }` or `{ matched: false, position }`
  - On match: create ticket in DB, set `agent_id`, `assigned_at`
  - On queue: create `pending` ticket, insert into Redis sorted set
- [ ] **M3.T4** — Queue position service
  - `getQueuePosition(customerId)` — `ZRANK queue:support customerId`
  - `estimatedWaitTime(position)` — based on avg handle time (configurable)
- [ ] **M3.T5** — Dequeue on agent free
  - `freeAgent(agentId)` — on ticket close/agent goes available: `ZPOPMIN queue:support` → assign next customer → create/update ticket

#### Milestone 4 — WebSocket Layer: Live Queue Position
> **Goal**: Every waiting customer sees their position update in real time as the queue moves.

- [ ] **M4.T1** — Socket.IO server setup
  - Attach to Express server; Redis adapter (`@socket.io/redis-adapter`) for multi-instance ready
  - Namespaces: `/customer`, `/agent`
- [ ] **M4.T2** — Customer socket events
  - `connect` → run `matchOrEnqueue`, emit `matched` or `queue:position`
  - `disconnect` → remove from queue if waiting, mark ticket stale
- [ ] **M4.T3** — Queue broadcast on change
  - On every `freeAgent()` call, iterate remaining queue members, push updated positions
  - Emit `queue:position { position, estimatedWait }` to each waiting customer's socket
- [ ] **M4.T4** — Agent socket events
  - `connect` → mark agent available in Redis, trigger `freeAgent` check (serve next in queue)
  - `disconnect` → mark agent offline, release any unclaimed tickets back to queue
- [ ] **M4.T5** — Frontend: Live queue widget
  - Customer sees "You are #N in queue, ~X min wait"
  - Animated queue position counter, updates live

#### Milestone 5 — Agent Claiming with Distributed Locking
> **Goal**: Multiple agents can attempt to claim the same ticket — exactly one wins.

- [ ] **M5.T1** — Redis distributed lock for ticket claiming
  - `SET lock:ticket:{ticketId} {agentId} NX PX 5000` — 5s lock, single atomic command
  - On success: update DB `tickets SET agent_id, assigned_at, status='assigned'`
  - On failure: return `{ error: 'already_claimed', claimedBy }` immediately
- [ ] **M5.T2** — Claim REST endpoint
  - `POST /api/tickets/:id/claim` — agent-only; runs lock logic
- [ ] **M5.T3** — Socket event: `ticket:claimed`
  - Emit to all agents: `{ ticketId, agentId, agentName }` so dashboards update instantly
  - Losing agents see ticket disappear from their unclaimed list immediately (no stale UI)
- [ ] **M5.T4** — Frontend: Agent claim UI
  - Unclaimed tickets list; "Claim" button per ticket
  - Optimistic UI + server-confirmation; graceful "already claimed" toast

#### Milestone 6 — Real-Time Chat
> **Goal**: Full bidirectional WebSocket chat once customer and agent are matched.

- [ ] **M6.T1** — Chat socket events
  - `chat:message { ticketId, body }` → validate sender is participant → persist to DB → emit to room `ticket:{ticketId}`
  - `chat:typing` / `chat:read` — optional indicators
- [ ] **M6.T2** — Message buffering (hot-path perf choice)
  - **Do NOT write to DB synchronously per message** — this is a deliberate perf decision
  - On `chat:message`: append to Redis List `chat:buffer:{ticketId}` (sub-millisecond), then emit to room
  - BullMQ `transcript-flush` job (set up here, worker in M9) drains the buffer to DB every 30s
  - Reconnect history served from Redis buffer first (recent) + DB (older) — seamless to client
  - *Interview talking point*: "We keep the WS hot path at in-memory speed; durability is eventual but bounded at 30s"
- [ ] **M6.T3** — Reconnect handling
  - On reconnect: client fetches message history via REST `GET /api/tickets/:id/messages`
  - Socket rejoins `ticket:{ticketId}` room; catches up on any missed messages
- [ ] **M6.T4** — Frontend: Chat UI
  - Split-panel: customer chat window + agent chat window
  - Message bubbles, timestamps, typing indicator animation
  - Auto-scroll to latest message

---

### 🔷 Phase 3 — Production Hardening (Milestone 7)

#### Milestone 7 — Multi-Instance WebSocket Scaling (Redis Pub/Sub)
> **Goal**: Run multiple backend instances behind a load balancer — any socket event emitted on instance A reaches a client connected to instance B.

- [ ] **M7.T1** — Redis Adapter for Socket.IO
  - `@socket.io/redis-adapter` — replaces in-process event bus with Redis pub/sub
  - All `io.to(room).emit(...)` calls now fan out across all instances automatically
- [ ] **M7.T2** — Shared state audit
  - Ensure all state (agent availability, queue, locks) lives in Redis — not process memory
  - No in-memory Maps that would break under multiple instances
- [ ] **M7.T3** — Test with 2 local instances
  - Run two server instances on different ports behind a basic nginx reverse proxy
  - Verify: customer on instance A, agent on instance B can chat + see queue updates
- [ ] **M7.T4** — Frontend: connect to load-balanced endpoint

---

### 🔷 Phase 4 — Background Jobs & Stretch Features (Milestones 8–11)

#### Milestone 8 — SLA Escalation Background Job
- [ ] **M8.T1** — BullMQ setup; `sla-escalation` queue
- [ ] **M8.T2** — SLA worker: every 60s, query tickets where `status='pending' AND created_at < NOW() - interval`, escalate (bump priority, reassign to senior agent or admin)
- [ ] **M8.T3** — Worker crash recovery: BullMQ job `removeOnComplete: false`, deduplication by ticketId
- [ ] **M8.T4** — Emit `ticket:escalated` socket event to agents on escalation

#### Milestone 9 — Auto-Close & Transcript Flush Worker
- [ ] **M9.T1** — Auto-close worker: tickets with no messages for N minutes → emit warning → close after grace period
- [ ] **M9.T2** — `transcript-flush` BullMQ worker (scaffolded in M6.T2, implemented here)
  - Every 30s: for each `chat:buffer:{ticketId}` key, batch-insert messages to DB, then delete key
  - Idempotent: uses Redis `GETDEL` / `LRANGE + DEL` atomically so a worker crash doesn't double-write
  - On ticket close: force-flush immediately so the transcript is complete before the close event fires

#### Milestone 10 — Notification System
- [ ] **M10.T1** — BullMQ `notifications` queue setup
- [ ] **M10.T2** — Email transport: Nodemailer (dev: Ethereal/Mailtrap; prod: SendGrid)
- [ ] **M10.T3** — Notification triggers: ticket assigned, escalated, auto-closed, offline message received
- [ ] **M10.T4** — Retry with exponential backoff (BullMQ `attempts: 3, backoff: { type: 'exponential', delay: 2000 }`)
- [ ] **M10.T5** — Dead-letter logging: log permanently failed notifications to DB
- [ ] **M10.T6** — Per-user notification preferences (`notification_preferences` table)
- [ ] **M10.T7** — Template caching (compile templates once, cache in memory)

#### Milestone 11 — Caching Layer
- [ ] **M11.T1** — Cache agent availability (already in Redis — formalize TTL strategy)
- [ ] **M11.T2** — Cache queue length + avg wait time estimate (recompute every 10s, push to waiting customers)
- [ ] **M11.T3** — Cache ticket message history (short TTL, invalidate on new message)

---

### 🔷 Phase 5 — Observability & Load Testing (Milestones 12–13)

#### Milestone 12 — Observability
- [ ] **M12.T1** — Structured logging with `pino` (JSON logs, correlation IDs per request)
- [ ] **M12.T2** — `/metrics` endpoint: queue depth, active agents, claim latency histogram, SLA escalation count
- [ ] **M12.T3** — `/health` endpoint: DB + Redis connectivity check

#### Milestone 13 — Load Testing (k6)
- [ ] **M13.T1** — k6 script: simulate N concurrent customers connecting (WebSocket) with limited agent pool
  - Phase 1: agents have capacity → instant match rate = 100%
  - Phase 2: agents saturate → queue fallback activates
- [ ] **M13.T2** — Assertions:
  - Zero double-claimed tickets
  - Zero double-matched customers (two customers to same agent)
  - Queue position update latency < 50ms p99
  - SLA escalation fires correctly under load
- [ ] **M13.T3** — Capture + document results in `README.md` → fill in resume bullet numbers

---

## Key Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Atomic matching | Lua script on Redis | Only way to eliminate the availability-check race without a distributed transaction |
| Ticket locking | `SET NX PX` (single command) | Atomic, lightweight, auto-expires on agent crash |
| Queue data structure | Redis Sorted Set (ZADD score=timestamp) | O(log N) insert/remove, FIFO by join time, ZRANK for position |
| WS scaling | Redis adapter (`@socket.io/redis-adapter`) | Transparent fan-out across instances, no code changes in event handlers |
| Notification delivery | BullMQ separate queue | Decoupled from chat path — slow email provider never blocks message delivery |
| Session continuity | REST fetch on reconnect | Clean separation: WS for live push, REST for reliable history |
| Refresh token storage | httpOnly cookie (`SameSite=Strict`, `Secure`) | localStorage is XSS-exposed; httpOnly cookie is invisible to JS, sent automatically on refresh calls |
| Login brute-force protection | `express-rate-limit` on `/api/auth/login` | IP-level rate limit; trivial to add in M1, strong interview answer, no external dependency |

---

## Environment Variables (`.env.example`)

```env
# Server
PORT=3001
NODE_ENV=development

# JWT
JWT_ACCESS_SECRET=changeme_access
JWT_REFRESH_SECRET=changeme_refresh
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# Neon PostgreSQL
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require

# Redis (local Docker)
REDIS_HOST=localhost
REDIS_PORT=6379

# SLA Config
SLA_ESCALATION_MINUTES=10
AUTO_CLOSE_MINUTES=30

# Email
SMTP_HOST=smtp.ethereal.email
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=support@queuedesk.local
```

---

## Verification Plan

### Per-Milestone
- Each milestone has its own testable deliverable before moving to the next
- REST endpoints verified with a `.http` file (REST Client for VS Code) or Postman collection
- WebSocket events verified with a simple test client script

### Load Testing (M13)
- k6 script runs against local or deployed instance
- Results documented in `README.md`

### Manual Verification
- Two browser windows: one customer, one agent — full flow from queue → match → chat → close
- Three browser windows: two agents simultaneously claiming the same ticket — one wins, one gets graceful error
