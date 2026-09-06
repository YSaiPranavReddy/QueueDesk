# QueueDesk — Real-Time Customer Support & Ticket Queue Platform

## One-line pitch
A Zendesk/Intercom-style live support platform where customers queue for an agent in real time, agents claim tickets without collision, and unassigned tickets auto-escalate via SLA timeouts — built to demonstrate production backend + devops skills, not just CRUD.

## Why this project (resume framing)
- **WebSockets are load-bearing, not decorative** — live chat and live queue position are the actual product; a support widget without real-time updates isn't a support widget. This is the cleanest, most defensible justification of any project in the lineup.
- **SLA-based auto-escalation** is a sharp, memorable interview detail — same flavor as the anti-sniping mechanic, but grounded in a real operational concern every support org has (tickets going stale).
- **Domain is universally recognized** — every SaaS company runs something like this internally; you're not reinventing e-commerce, you're building infra companies actually depend on.
- **Reuses TicketFlow's queue pattern**, but here the queue is the headline feature, not a bonus layer.

---

## Core Flow

```
Customer opens chat → WebSocket connection established → check agent availability
     → IF an agent is idle: instant match, no queue entry → live chat session begins
     → IF no agent is free: customer joins support queue
          → position pushed live ("You are #4, next available agent in ~2 min")
          → pulled from queue the moment an agent frees up
     → agent claims ticket (locked so no double-claim) → live chat session begins
     → if ticket sits unassigned past SLA window → background job auto-escalates
     → session ends → ticket closed, transcript saved
```
The queue is a fallback for demand spikes, not the default path — most real support widgets match instantly when capacity allows and only show a queue position once agents are saturated.

---

## Subsystems

### 1. Authentication & authorization
- JWT-based auth for both customers and agents (separate roles, same token scheme)
- Role-based access control: customer, agent, admin — enforced at the API and WebSocket layer, not just hidden in the UI
- WebSocket connections authenticated on handshake (token passed at connect, not trusted from an open socket) — a common real vulnerability if skipped
- Authorization boundaries worth calling out explicitly: only an assigned agent (or admin) can view a ticket's internal notes; only an agent can claim a ticket; only an admin can reassign/escalate manually
- Session/token refresh handling so a long support session doesn't get silently kicked mid-chat

### 2. Live queue (core hard problem)
- **Fast path first**: on connect, check cached agent availability — if an agent is idle, match instantly and skip the queue entirely (no position, no wait)
- **Queue as fallback**: only when no agent is free does the customer enter the Redis sorted set, score = join timestamp (FIFO fairness)
- Live position pushed via WebSocket to each waiting customer as the queue moves
- Matching logic assigns next available agent to next customer in line (queued customers pulled out the moment an agent frees up)
- Availability check + queue-insert (or availability check + claim) must be atomic (single Redis transaction / Lua script) to avoid a race where two customers connecting in the same instant both see the same agent as "free"

### 3. Ticket claiming / locking
- When a ticket becomes available, multiple online agents could try to claim it simultaneously — use a Redis distributed lock (or DB row lock) so exactly one agent wins the claim
- Losing agents get an immediate "already claimed" response, no stale UI state

### 4. Real-time chat layer
- WebSocket-based messaging between customer and agent once matched
- Typing indicators / read receipts (optional stretch, but a nice live-feel detail)
- Reconnect handling: customer or agent dropping connection shouldn't lose the session or message history

### 5. Background jobs
- SLA-timeout escalation worker: scans unassigned tickets on an interval, auto-escalates/reassigns any ticket unassigned past N minutes
- Auto-close worker: closes tickets inactive (no messages either side) for N minutes, notifies customer
- Transcript persistence: periodic snapshot of chat history to DB instead of writing every message synchronously in the hot path (optional perf choice worth explaining in interviews)

### 6. Caching
- Agent availability/online status cached in Redis (hot read — every routing decision checks this)
- Queue length / estimated wait time cached and pushed to waiting customers

### 7. Notification system
- Multi-channel dispatch: email (and optionally SMS/push) triggered on key events — ticket auto-escalated, agent assigned, customer message received while the other party is offline
- Delivery via a background job queue (BullMQ), decoupled from the main request path so a slow email provider never blocks a chat/API response
- Retry with exponential backoff on delivery failure; dead-letter/log entry for notifications that fail permanently after max retries
- Per-user notification preferences (e.g. customer opts into email-only, agent opts into none) — small feature but shows you're thinking about the system as something real users configure, not just a demo
- Template rendering cached (subject/body templates don't change per-send, no reason to re-render from scratch every time)

### 8. Error handling
- Reject a ticket claim if it's already been claimed (race condition on simultaneous agent clicks)
- Threshold race: if multiple customers connect the instant agent capacity flips from available to saturated, the availability-check-and-match must be atomic so two customers can't both get matched to the same freshly-busy agent — one wins the instant match, the other correctly falls into the queue
- Graceful handling of customer disconnect mid-chat vs mid-queue (different recovery paths)
- Worker crash recovery: SLA-escalation and auto-close jobs must resume correctly without double-escalating a ticket
- Notification delivery failures (bad email, provider downtime) must not crash or block the escalation/close job that triggered them

---

## Load Testing (the proof)

- Simulate a support spike: N concurrent customers connecting while a limited pool of agents comes online — the test should demonstrate the transition from instant-match (while agents have spare capacity) to queue fallback (once capacity is exceeded)
- Tools: k6 or Locust (WebSocket load testing support in k6 via its `ws` module)
- Metrics to capture and publish:
  - Zero double-claimed tickets under concurrent agent claims
  - Zero double-matched tickets at the instant-match/queue threshold (no two customers matched to the same agent in the same window)
  - Queue position update latency (how fast does a customer's position refresh after someone ahead of them is served)
  - Instant-match rate vs. queued rate as agent capacity is exceeded (proves the queue only activates under load, as designed)
  - SLA-escalation correctness under load (do stale tickets reliably escalate on time even when the system is busy)
  - Agent-matching throughput (tickets/min assigned)

---

## Suggested Stack

| Layer | Choice |
|---|---|
| Backend | Node.js/Express or FastAPI |
| Auth | JWT (access + refresh tokens), bcrypt/argon2 for password hashing |
| Real-time | Socket.IO (or native WebSocket) |
| DB | Postgres (Neon/Supabase) |
| Cache/Queue | Redis (self-hosted) |
| Background jobs | BullMQ |
| Notifications | Nodemailer/SendGrid (email); Twilio optional for SMS |
| Load testing | k6 (with WebSocket support) |
| Deploy | Oracle Cloud free tier |

---

## Build Order (suggested milestones)

1. **Auth & RBAC**: JWT-based login for customer/agent/admin roles, authenticated WebSocket handshake
2. **Data model + basic REST API**: customers, agents, tickets, messages — plain CRUD first
3. **Matching logic**: instant-match fast path when an agent is idle (checked atomically), falling back to the Redis sorted-set queue (join/leave, position calculation) only when no agent is free
4. **WebSocket layer**: push live queue position to waiting customers
5. **Agent claiming with locking**: concurrency-safe ticket assignment
6. **Real-time chat**: WebSocket messaging once customer and agent are matched
7. **Multi-instance WebSocket scaling (new)**: Redis pub/sub to broadcast queue-position, ticket-claim, and chat events across backend instances, so the system isn't secretly single-instance-only once you scale horizontally — placed here because it needs queue, claim, and chat events all emitting before there's anything to broadcast
8. **SLA-escalation background job**: auto-escalate unassigned tickets past timeout
9. **Auto-close + transcript persistence jobs**
10. **Notification system**: multi-channel dispatch via background queue, retry with backoff, per-user preferences
11. **Caching layer**: agent availability, queue length/wait-time estimates
12. **Observability (new)**: `/metrics` endpoint (queue depth, claim latency, SLA-escalation count) + structured logging, built on the same numbers already computed for load testing — placed here so the metrics endpoint exists before load testing needs it
13. **Load testing**: script the support-spike simulation, capture and document metrics, now also validated against the observability endpoint from step 12

### MVP scope note
Milestones 1–7 are the core deliverable — auth through multi-instance WebSocket scaling. Auto-close, notifications, and caching (8–11) are stretch goals if time permits. A fully working core with a strong load test beats a sprawling, half-finished system with every subsystem attempted.

---

## Resume Bullet (draft, fill in numbers after load testing)
> Built a real-time customer support platform with JWT-based auth and role-based access control, a Redis-backed live queue for agent matching, distributed locking to prevent duplicate ticket claims, SLA-based auto-escalation, and a multi-channel notification system with retry-with-backoff delivery via background workers. Load-tested with k6 simulating concurrent support spikes, achieving zero double-claimed tickets and sub-Xms queue-position update latency.
