# Bug Fixes & Resiliency Update (M6.5)

I've successfully implemented the 5 critical bug fixes to stabilize the QueueDesk core matching and chat engines.

## What's Changed

### 1. Queue Drain Fixed
**Scenario 2 now completes correctly.**
- When an agent finishes a ticket, `releaseAgent` runs the atomic Lua script to check the queue.
- If a customer is found, a new `assignNextInQueue` helper is called.
- This helper performs the DB `UPDATE tickets SET agent_id = ...` and emits the `ticket:matched` and `ticket:assigned` WebSocket events. 
- The waiting customer instantly sees their chat panel appear, and the agent gets the new ticket.

### 2. Status Race Condition Eliminated
**No more double-bookings on status toggle.**
- `markAgentAvailable` no longer performs non-atomic writes. It solely executes the `FREE_AGENT_SCRIPT` Lua script.
- Because the script is atomic, it handles both states flawlessly:
  - If the queue is empty, the agent is added to the available pool.
  - If the queue has customers, the agent is kept busy and matched instantly.
- The `PATCH /api/agents/status` route was updated to call `assignNextInQueue` if the atomic script results in an immediate match.

### 3. Agent Disconnection (30s Grace Period)
**No more silent failures on tab crash or WiFi drop.**
- When an agent's socket disconnects, their status is immediately marked `offline` in Redis so they stop receiving new tickets.
- A 30-second in-memory grace period timer starts for any active tickets they were assigned to.
- If the agent fails to reconnect within 30 seconds, `recirculateTicket` fires:
  - The ticket is unassigned in the DB.
  - The customer is placed at the absolute front of the queue (`ZADD queue:support 0 customerId`).
  - A socket event is sent to the customer to update their UI back to the waiting queue position.

> [!TIP]
> **Why an in-memory timer for now?**
> A simple Node `setTimeout` is used for the grace period. In M9 (BullMQ), we will upgrade this to a persistent delayed job so it survives a server crash, but for now, this fully solves the problem of customers getting permanently stuck when an agent drops off.

### 4. Chat Security Enforced
**Private rooms are now actually private.**
- `chatHandlers.js` and the Socket.IO `connection` listener both now hit the database to verify `ticket.customer_id === userId` before allowing a customer to join a ticket room or pull chat history.
- Agents are also strictly verified against `ticket.agent_id`.

### 5. Refresh Token Logic Fixed
**Users won't be randomly logged out anymore.**
- Replaced the slow `bcrypt` hashing for refresh tokens with instantaneous `SHA-256`.
- We can now perform a direct, O(1) indexed database query (`WHERE token_hash = $1`) instead of fetching the 50 newest tokens and brute-forcing them.
- This fully prevents the bug where active users get logged out simply because 50 other users logged in after them.

## Verification
- Both backend and frontend servers have been restarted.
- Redis Lua scripts were successfully executed.
- The DB schema for refresh tokens gracefully accepts the new SHA-256 hex strings.
