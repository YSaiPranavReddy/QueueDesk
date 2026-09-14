<div align="center">
  <img src="client/public/logo.png" alt="QueueDesk Logo" width="120" />
  <h1>QueueDesk</h1>
  <p><strong>Enterprise-Grade Real-Time Customer Support Infrastructure</strong></p>

  <p>
    <a href="https://react.dev"><img src="https://img.shields.io/badge/React-18.x-61DAFB?logo=react&logoColor=black" alt="React" /></a>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-20.x-339933?logo=nodedotjs&logoColor=white" alt="Node" /></a>
    <a href="https://socket.io/"><img src="https://img.shields.io/badge/Socket.IO-4.x-010101?logo=socketdotio&logoColor=white" alt="Socket.IO" /></a>
    <a href="https://redis.io/"><img src="https://img.shields.io/badge/Redis-PubSub%2FQueues-DC382D?logo=redis&logoColor=white" alt="Redis" /></a>
    <a href="https://postgresql.org/"><img src="https://img.shields.io/badge/PostgreSQL-Neon-4169E1?logo=postgresql&logoColor=white" alt="Postgres" /></a>
    <a href="https://taskforce.sh/"><img src="https://img.shields.io/badge/BullMQ-Background%20Jobs-4B32C3?logo=redis&logoColor=white" alt="BullMQ" /></a>
  </p>
</div>

---

## ⚡ Overview

QueueDesk is a highly concurrent, horizontally scalable customer support platform built for real-time resolution. It intelligently routes customers to available agents, facilitates live WebSocket-based communication, tracks strict Service Level Agreements (SLAs), and gracefully handles network disconnects and state recovery without dropping tickets.

## ✨ Key Features

- **Intelligent Routing:** Sticky routing reconnects customers to their previous agent if available. Otherwise, fair-queueing distributes load across the agent pool.
- **Resilient Real-Time Chat:** Socket.IO with Redis Adapter ensures messages are delivered across multiple server instances.
- **Distributed Locking:** Redis `SET NX EX` prevents race conditions where two agents might claim the same ticket simultaneously.
- **Automated SLA Escalations:** BullMQ cron jobs constantly monitor ticket wait times, escalating priority and alerting staff when SLAs are breached.
- **Graceful Disconnect Handling:** Background workers monitor WebSocket connections, giving users a grace period to reconnect before freeing up the agent or putting the ticket on hold.
- **Asynchronous Email Delivery:** Resend API integration powered by background queues ensures the main API thread is never blocked by email delivery.

---

## 🏗️ System Architecture

QueueDesk is designed to be horizontally scaled. The backend can run across multiple instances, relying on Redis for shared state, job queues, and Pub/Sub.

```mermaid
graph TD
    Client[Web Clients React] -->|HTTPS / WSS| LB[Load Balancer]
    LB --> Node1[API Node 1]
    LB --> Node2[API Node 2]
    
    Node1 <-->|Read/Write| DB[(PostgreSQL Neon)]
    Node2 <-->|Read/Write| DB
    
    Node1 <-->|Pub/Sub, Locks, BullMQ| Redis[(Redis Upstash)]
    Node2 <-->|Pub/Sub, Locks, BullMQ| Redis
    
    subgraph Background Workers
        Worker1[Disconnect Worker]
        Worker2[SLA Monitor Worker]
        Worker3[Email Notification Worker]
    end
    
    Redis <--> Worker1
    Redis <--> Worker2
    Redis <--> Worker3
```

---

## 🔄 Core Workflows

### 1. Intelligent Ticket Matching & Routing
When a customer submits a ticket, the system attempts to route them efficiently, prioritizing agents they have interacted with recently (Sticky Routing).

```mermaid
sequenceDiagram
    participant C as Customer
    participant API as Express API
    participant DB as PostgreSQL
    participant R as Redis
    participant A as Agent (WebSocket)

    C->>API: POST /api/tickets (Create Ticket)
    API->>DB: Save Ticket (Status: Pending)
    API->>R: Check Sticky Queue for Customer
    
    alt Agent Found in Sticky Queue
        API->>R: Check if Agent is Online & Available
        alt Agent Available
            API->>DB: Assign Ticket to Agent
            API->>A: Emit 'ticket:assigned'
            API->>C: Emit 'ticket:matched'
        else Agent Offline/Busy
            API->>R: Push to General Waiting Queue
        end
    else No Sticky Agent
        API->>R: Push to General Waiting Queue
        API->>A: Emit 'ticket:pending' (Broadcast to all agents)
    end
```

### 2. Distributed Chat Flow (Horizontal Scaling)
Because Node instances are scaled horizontally, Customer A and Agent B might be connected to completely different servers. Redis Pub/Sub bridges the gap.

```mermaid
sequenceDiagram
    participant C as Customer (on Node 1)
    participant N1 as Node 1 (Socket.IO)
    participant Redis as Redis Pub/Sub
    participant N2 as Node 2 (Socket.IO)
    participant A as Agent (on Node 2)
    participant DB as Database

    C->>N1: emit 'chat:message'
    N1->>DB: INSERT into messages
    N1->>Redis: Publish to room 'ticket:123'
    Redis->>N2: Receive Published Message
    N2->>A: emit 'chat:message'
```

### 3. Connection Resilience & Abandonment
Network drops are inevitable. QueueDesk uses BullMQ to manage a grace period, ensuring temporary drops don't abruptly end sessions.

```mermaid
stateDiagram-v2
    [*] --> Connected
    
    Connected --> Disconnected: Socket Drop
    
    state Disconnected {
        [*] --> GracePeriod: Schedule BullMQ Job (30s)
        GracePeriod --> Reconnected: Socket reconnects
        GracePeriod --> Abandoned: Timer expires
    }
    
    Reconnected --> Connected: Cancel Job
    
    Abandoned --> [*]: Mark Offline / Put Tickets on Hold / Recirculate
```

### 4. SLA Monitoring & Escalation
A scheduled BullMQ job runs iteratively to ensure no ticket sits idle beyond its Service Level Agreement.

```mermaid
sequenceDiagram
    participant Cron as BullMQ SLA Worker (Every 1m)
    participant DB as PostgreSQL
    participant WS as WebSocket Server
    participant Email as Notification Worker

    Cron->>DB: SELECT tickets WHERE status='pending' AND wait_time > SLA
    
    loop For each breached ticket
        DB-->>Cron: return ticket
        Cron->>DB: UPDATE priority = 'escalated'
        Cron->>WS: Emit 'ticket:escalated' to Managers
        Cron->>Email: Add Job (Send Warning Email)
    end
```

---

## 🛠️ Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Frontend** | React (Vite), CSS Modules | Fast, component-based UI. Premium custom design system. |
| **Backend** | Node.js, Express | Non-blocking API for handling high concurrency. |
| **Database** | PostgreSQL (Neon DB) | Serverless, ACID-compliant relational data storage. |
| **Caching/PubSub** | Redis (Upstash) | Distributed state, Socket.IO adapter, and distributed locks. |
| **Job Queue** | BullMQ | Reliable, Redis-based queues for background tasks and crons. |
| **Real-Time** | Socket.IO | Bi-directional event-based communication. |
| **Logging** | Pino | Structured, high-performance JSON logging. |
| **Emails** | Resend SDK | Transactional email delivery. |

---

## 🚀 Getting Started (Local Development)

### 1. Prerequisites
- Node.js (v18 or higher)
- Docker & Docker Compose (for local Redis/Postgres) *or* cloud equivalents (Neon/Upstash).

### 2. Clone and Install
```bash
git clone https://github.com/YSaiPranavReddy/QueueDesk.git
cd QueueDesk

# Install backend dependencies
cd server
npm install

# Install frontend dependencies
cd ../client
npm install
```

### 3. Environment Variables
Create a `.env` file in the `server` directory. Refer to `.env.example`.
```env
PORT=10000
DATABASE_URL=postgresql://user:pass@localhost:5432/queuedesk
REDIS_URL=redis://localhost:6379
JWT_SECRET=your_super_secret_key
JWT_REFRESH_SECRET=your_super_secret_refresh_key
RESEND_API_KEY=re_your_api_key
FRONTEND_URL=http://localhost:5173
NODE_ENV=development
```

Create a `.env` file in the `client` directory:
```env
VITE_API_URL=http://localhost:10000/api
VITE_SOCKET_URL=http://localhost:10000
```

### 4. Start the Application
Run everything locally:

```bash
# Start backend (from /server)
npm run dev

# Start frontend (from /client)
npm run dev
```

---

## ☁️ Production Deployment

QueueDesk is optimized for modern cloud deployments:

- **Frontend:** Deployed globally on [Vercel](https://vercel.com).
- **Backend:** Deployed as a web service on [Render](https://render.com).
- **Database:** Serverless Postgres via [Neon](https://neon.tech).
- **Redis:** Serverless Redis via [Upstash](https://upstash.com).

**Critical Production Notes:**
- Ensure `NODE_ENV=production` is set on the backend to enforce `Secure; SameSite=None` cookies for cross-origin authentication.
- Set the `FRONTEND_URL` environment variable to strictly control Socket.IO and API CORS policies.

---

## 📄 License

This project is licensed under the MIT License.
