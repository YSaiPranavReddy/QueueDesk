# QueueDesk — Issue Tracker (TOCTOU Audit + Pre-M12 Hardening)

Status legend: 🔴 Must fix before load test · 🟡 Should fix / confirm intentional · 🟢 Info / no action needed · ✅ Resolved

---

## Batch 1 — Models & Routes (reviewed)

### ✅ Resolved (confirmed correct in this batch)

- **`assignTicket`** — guarded with `WHERE id=$1 AND status IN ('pending','open')`, throws `ConcurrencyError` on `rowCount===0`. Correct — this is the fix for the Scenario 1 "Stolen Ticket" race.
- **`unassignTicket`** — guarded with `WHERE id=$1 AND status != 'closed'`, throws on failure. Correct — fixes Scenario 2 "Zombie Resurrection."
- **`closeTicket`** — guarded with `WHERE id=$1 AND status != 'closed'`, throws on failure. Transcript force-flush, `updateAvgHandleTime`, and `sendTicketClosed` all correctly gated behind the successful guard (they only run if the guarded `UPDATE` actually returned a row).
- **`putTicketOnHold`** — now guarded (`status='assigned'`) and throws `ConcurrencyError` instead of silently returning `undefined`. Fixes the "Manual Agent Hold Failure" finding.
- **`autoHoldTicket`** (new) — correctly scoped to `status='assigned' AND updated_at < NOW() - 30 min`, throws on failure. Matches the Scenario 3 fix.
- **`autoCloseStaleTicket`** (new) — correctly scoped to `status='open' AND waiting_on_customer=true AND updated_at < NOW() - 24h`, throws on failure. Matches the Phase 2 fix.
- **`escalateTicket`** — confirmed deleted. Dead code removed as agreed.
- **`routes/tickets.js` `/hold`** — now catches `ConcurrencyError` specifically and returns 409 *before* calling `releaseAgent`. Correct — this was the exact gap flagged (agent capacity was being freed even when the hold itself failed).
- **`routes/tickets.js` `/close`** — same pattern, catches `ConcurrencyError` → 409, skips `releaseAgent`/`removeFromQueue` on failure. Correct.
- **Message model, User model, Messages routes** — unchanged from previously-verified versions. No new issues.

### 🟡 Open — needs Batch 3 (Workers) to confirm

- **`autoCloseStaleTicket` bypasses `closeTicket`'s side effects entirely.** `closeTicket` does three important things beyond the raw status flip: (1) force-flushes the Redis chat buffer via `forceFlushTranscript` so no messages are lost, (2) calls `updateAvgHandleTime` for queue-estimate accuracy, (3) calls `sendTicketClosed` for the customer notification email. `autoCloseStaleTicket` is a bare guarded `UPDATE` with **none** of these. If `autoCloseWorker.js`'s Phase 2 calls `autoCloseStaleTicket` directly (as the naming suggests it's meant to), auto-closed tickets will silently skip the closure email, the handle-time stat, and — most importantly — any messages still sitting unflushed in the Redis buffer for that ticket at close time. **Action:** when Batch 3 arrives, confirm whether the worker calls `autoCloseStaleTicket` and then separately replicates these three side effects itself, or whether they need to be added. If not replicated, either fold them into `autoCloseStaleTicket` itself or have the worker call them explicitly after a successful guard.
- Same class of question for **`autoHoldTicket`** vs. whatever side effects `putTicketOnHold`/the original Phase 1 code performed (system message insert, `ticket:on_hold` emit) — need to confirm those still fire from the worker after switching to the new guarded function.

### 🟢 Info / low priority

- **`findSlaBreachedTickets`** — appears unused (per earlier review, `slaWorker.js` uses its own inline query). Same category as the deleted `escalateTicket`. Flag for cleanup once workers batch confirms it's genuinely dead.
- **`setTicketPriority`** remains an unguarded blind update. App-layer check (`ticket.status === 'closed'` before calling) exists in the route, so the TOCTOU window here is narrow and the consequence (priority changes on a ticket mid-transition) is low-severity. Not recommending a DB guard for this one unless it starts causing issues under load test.

---

## Batch 2 — Services & Socket (reviewed)

### ✅ Resolved (confirmed correct in this batch)

- **Lua `ARGV` reuse bug (from the M11 caching round) — fixed.** `MATCH_OR_ENQUEUE_SCRIPT` now takes separate `now` (ARGV[1], used only for the staleness cutoff) and `insertScore` (ARGV[2], used for the actual `ZADD`). `matchOrEnqueue` passes the same real timestamp for both; `recirculateCustomer` correctly passes a real `Date.now()` for `now` and the deeply-negative priority score for `insertScore`. The `ZREMRANGEBYSCORE` zombie-cleanup sweep now actually runs on every call, including recirculation — this was previously silently skipped on the recirculation path, which was one of the two paths most likely to need it (agent disconnects).
- **`updateAvgHandleTime` is now called** — confirmed wired into `closeTicket` (seen in Batch 1) via `assigned_at`/`closed_at` diff. Resolves the long-open "dead code, queue estimates never adapt" item.
- **`assignNextInQueue` and `routePendingTicket`** now both distinguish `ConcurrencyError` from generic errors in their catch blocks (`console.warn` vs `console.error`), and both correctly call `releaseAgent` to roll the agent back to the available pool before rethrowing. Matches the approved fix for Scenario 1's rollback path.
- **Instant `broadcastQueueShift` restored** alongside the M11 `statsWorker` 10s poll — `assignNextInQueue` and `routePendingTicket`'s queued branch both call it immediately on state change now, with the 10s poll acting as a periodic refresh/safety net rather than the only mechanism. This is a better design than either extreme (pure-instant or pure-polling) and resolves the earlier open question about which one you wanted — looks like you kept both, which is the right call.

### 🔴 New — Critical gap: `claimTicket` doesn't catch `ConcurrencyError` from `assignTicket`

This is directly relevant to Scenario 1, the race the whole audit was built around. Look at `claimTicket` in `claimService.js`:

```js
try {
  const ticket = await findTicketById(ticketId);
  if (ticket.status !== "pending") { return { success: false, reason: "already_claimed", ... }; }
  const assigned = await assignTicket(ticketId, agentId);   // ← can now throw ConcurrencyError
  return { success: true, ticket: assigned };
} finally {
  await redis.del(key);
}
```

There's a `finally` but **no `catch`**. `assignTicket` now throws `ConcurrencyError` when its guarded `UPDATE` finds `rowCount===0` — and that's exactly what would happen in the real Scenario 1 sequence: Agent A's `claimTicket` does its own `findTicketById` check (sees `pending`), but between that `await` and the subsequent `await assignTicket(...)`, the event loop can interleave and let a concurrent Lua-based auto-match (Agent B's `routePendingTicket` → `assignTicket`) complete first. Agent A's own `assignTicket` call then hits the guard, finds the ticket no longer `pending`, and throws.

Since `claimTicket` has no `catch`, this exception isn't converted into the `{ success: false, reason: 'already_claimed' }` shape the route expects — it propagates straight out of `claimTicket` as an unhandled rejection. `routes/tickets.js`'s `/claim` handler's `try/catch` will catch it, but fall through to the generic `next(err)` path, producing an unstyled 500 instead of the clean 409 "Ticket already claimed" response every other race-loss path in this system correctly returns. This is the one gap left in an otherwise complete TOCTOU fix — the audit closed the race at the DB layer but this specific call site never learned how to interpret the new failure mode.

**Fix:**
```js
try {
  const ticket = await findTicketById(ticketId);
  if (!ticket) return { success: false, reason: "not_found" };
  if (ticket.status !== "pending") return { success: false, reason: "already_claimed", currentStatus: ticket.status };
  if (ticket.agent_id && ticket.agent_id !== agentId) return { success: false, reason: "already_claimed" };

  const assigned = await assignTicket(ticketId, agentId);
  return { success: true, ticket: assigned };
} catch (err) {
  if (err.name === 'ConcurrencyError') {
    return { success: false, reason: 'already_claimed' };
  }
  throw err;
} finally {
  await redis.del(key);
}
```

### 🟡 Minor consistency — two other `assignTicket` call sites don't distinguish `ConcurrencyError` either

`matchOrEnqueue` (in `matchingService.js`) and `routeStickyTicket` both catch `assignTicket` failures generically (`console.error`, roll back, rethrow) without the `err.name === 'ConcurrencyError'` branch that `assignNextInQueue`/`routePendingTicket` now have. Practically low-risk — the race window for these two specific call sites is much narrower than Scenario 1's claim-vs-auto-match case (a ticket that was just created and Lua-matched a moment ago is unlikely to already be claimed by someone else) — but worth the same one-line distinction for consistent logging if you're doing a cleanup pass.

### 🟡 `joinAgentToTicketRoom`/`joinCustomerToTicketRoom` implementation changed — confirm this was intentional

Previously: `getIo().in(room).socketsJoin(ticketRoom)` — a single batched adapter-level operation. Now: `fetchSockets()` + a manual loop calling `.join()` on each returned socket. Both approaches work correctly across M7's multi-instance setup (`fetchSockets()` returns adapter-aware `RemoteSocket` proxies that do support `.join()` remotely), so this isn't a correctness bug — but it does trade one batched operation for N individual ones per call, which is a small overhead increase specifically under concurrent load (exactly what your upcoming k6 test will stress). Worth confirming this change was deliberate (e.g., `socketsJoin` had some issue you hit) rather than an incidental rewrite — if there's no specific reason, reverting to `socketsJoin` would be slightly more efficient with identical behavior.

### 🟢 Minor cleanup

- `socket/index.js`'s customer-disconnect handler still fetches `getQueueMembers()` into `remaining` but the body is now just a comment — the fetch itself is dead work. Harmless, but a stray Redis call worth trimming.
- `getUserNotificationPref` in `notificationService.js` remains defined but unused (confirmed again — `getFullTicket` is what all four `send*` functions actually use). Same as previously noted; fine to delete whenever convenient.

---

## Batch 3 — Workers (reviewed)

### ✅ Resolved / confirmed correct

- **`autoCloseWorker.js` both phases correctly catch `ConcurrencyError` per-ticket** and `continue` to the next one rather than letting one race-loss kill the entire batch job. This is exactly the right defensive pattern — good implementation of the approved fix.
- **`disconnectWorker.js`, `reminderWorker.js`, `slaWorker.js`, `statsWorker.js`, `transcriptWorker.js`** — all unchanged from previously-verified versions. No new issues in any of these five files.

### 🔴 New — Regression: `autoHoldTicket` nulls `agent_id`, breaking sticky routing (same bug class already fixed once in `disconnectWorker.js`)

Recall from several rounds back: the original `autoCloseWorker` Phase 1 nulled `agent_id` when auto-holding a ticket, which broke `routeStickyTicket`'s ability to reconnect a returning customer to their original agent (since that function's whole check is `ticket.status === 'open' && ticket.agent_id`). We fixed the equivalent case in `disconnectWorker.js`'s customer-abandon path by switching to `putTicketOnHold`, which deliberately does **not** null `agent_id` — confirmed in Batch 1's `ticket.js`:

```sql
-- putTicketOnHold (correct — keeps agent_id for sticky routing)
UPDATE tickets SET status = 'open', updated_at = NOW(), waiting_on_customer = false WHERE id = $1 AND status = 'assigned'
```

But the new `autoHoldTicket` function (also from Batch 1, used here in `autoCloseWorker.js` Phase 1) reintroduces the exact same bug we already fixed:

```sql
-- autoHoldTicket (regression — nulls agent_id, same mistake as before)
UPDATE tickets SET status = 'open', agent_id = NULL, waiting_on_customer = true WHERE id = $1 AND status = 'assigned' AND updated_at < NOW() - INTERVAL '30 minutes'
```

This has two concrete consequences, one worse than the other:

1. **Sticky routing breaks** — a customer replying to this auto-held ticket will never get reconnected to their original agent via `routeStickyTicket`, since `ticket.agent_id` is now `null`. Their reply just gets buffered/broadcast into a room nobody's specifically watching for it.
2. **The ticket vanishes from the agent's "On-Hold" tab entirely** — `AgentDashboard.jsx`'s filter is `t.agent_id === user?.id && t.status === 'open'`. With `agent_id` nulled, this ticket can never match that filter for *any* agent — it's not pending (so it won't show in the queue either), not assigned to anyone, and not visible in anyone's on-hold list. It becomes genuinely orphaned in the UI even though it's sitting in the DB with a perfectly valid `status='open'`.

The worker still passes `releaseAgent(ticket.agent_id, ticket.id)` using the `agent_id` captured from its own `SELECT` (before the nulling `UPDATE` ran), so agent capacity does get correctly freed — that part isn't broken. It's specifically the DB-level nulling that causes the problem.

**Fix** — `autoHoldTicket` should match `putTicketOnHold`'s pattern and not touch `agent_id`:
```sql
UPDATE tickets
SET status = 'open', waiting_on_customer = true
WHERE id = $1 AND status = 'assigned' AND updated_at < NOW() - INTERVAL '30 minutes'
RETURNING *
```

### 🟡 Confirmed as predicted: Phase 2 (`autoCloseStaleTicket`) still skips `closeTicket`'s side effects — severity downgraded on one count

Confirmed — the worker calls `autoCloseStaleTicket` directly and does not separately call `updateAvgHandleTime` or `sendTicketClosed`. Two consequences:

- **No closure email** — a customer whose ticket auto-closes after 24h of silence never gets notified. Given the original spec explicitly wanted an auto-close worker with this exact scenario in mind, this is likely a real gap worth closing, not just a cosmetic one.
- **Avg handle time stat skipped** for auto-closed tickets — minor, since these are inherently outlier-duration tickets (30min+24h) that would skew the EMA anyway if included; arguably fine to exclude on purpose.

**One correction from my Batch 1 note:** I'd flagged a risk of *permanent* message loss from skipping the transcript flush. On closer look, that risk is lower than I said — `transcriptWorker.js`'s own cron unconditionally scans `chat:buffer:*` every 30s regardless of ticket status, so any buffered messages for this ticket will still get flushed to Postgres on the next tick even after the ticket closes. `insertMessage`/`batchInsertMessages` don't check ticket status before inserting. So messages aren't lost — just written a few seconds after the ticket officially closes. Not a functional bug, just a minor sequencing quirk worth being aware of (a "closed" ticket's transcript could still be actively being written to for a few seconds after closure).

**Recommendation:** at minimum, add `sendTicketClosed(ticket.id)` after a successful `autoCloseStaleTicket` call — that's the one piece with real user-facing impact. `updateAvgHandleTime` is optional/arguably correct to skip.

### 🟢 Minor cleanup

- `autoCloseQueue`'s `CLOSE_MINUTES = config.sla.autoCloseMinutes` remains defined but unused (both phases hardcode `30 minutes`/`24 hours` directly in SQL rather than using this config value). Either wire it in (parameterize the interval) or delete the dead variable.

---

## Batch 4 — Configs & Frontend (reviewed)

### ✅ Resolved / confirmed correct

- **`nginx.conf` load-balancing upgrade — unprompted fix to a previously-flagged future concern.** Several rounds back I noted that plain `ip_hash` (hashing on raw `$remote_addr`) would break down if the app ever sat behind a CDN, since all traffic would then appear to originate from the CDN's IP and collapse onto one backend. This version now does:
  ```nginx
  map $http_x_forwarded_for $client_real_ip { ""  $remote_addr; default $http_x_forwarded_for; }
  upstream queuedesk_api { hash $client_real_ip consistent; ... }
  ```
  This correctly prefers the forwarded client IP when present (CDN/LB scenario) and falls back to `$remote_addr` for direct connections, and switches to consistent hashing (better rebalancing behavior if a backend is added/removed) instead of plain `ip_hash`. Good, deliberate improvement — nothing further needed here.
- **`ecosystem.config.js`** — unchanged, still correct.
- **`useSocket.js`'s reconnect/token-refresh behavior** — still correct (`auth` as a function re-reading a fresh token per attempt, `reconnectionAttempts: Infinity`), unchanged from the earlier verified fix.
- **`AgentDashboard.jsx` / `CustomerDashboard.jsx`** — otherwise unchanged from previously-verified versions; no new issues beyond the one below.

### 🟡 New — Duplicate heartbeat mechanism (harmless but wasteful, worth cleaning up before the load test)

`useSocket.js` now has its own agent heartbeat, correctly scoped to the socket's connect/disconnect lifecycle:
```js
socket.on('connect', () => {
  if (user?.role === 'agent') {
    socket.emit('ping:agent');
    pingInterval = setInterval(() => socket.emit('ping:agent'), 30000);
  }
});
socket.on('disconnect', () => { if (pingInterval) clearInterval(pingInterval); });
```
But `AgentDashboard.jsx` **still has its own separate heartbeat effect** from before this change:
```js
useEffect(() => {
  if (!socket) return;
  socket.emit('ping:agent');
  const interval = setInterval(() => socket.emit('ping:agent'), 30000);
  return () => clearInterval(interval);
}, [socket]);
```
Every connected agent is now sending `ping:agent` from **two independent 30-second intervals** simultaneously. Not a correctness bug — `refreshAgentTTL`'s `ZADD 'XX' 'CH'` is safe to call redundantly, it just refreshes the same TTL/score twice as often as needed — but it doubles a category of socket traffic and Redis calls per agent for no benefit, which is exactly the kind of small inefficiency your upcoming k6 load test is meant to surface and which would otherwise read as unexplained extra load in the results.

**Fix:** delete the heartbeat `useEffect` from `AgentDashboard.jsx` entirely — `useSocket.js`'s version is architecturally the better home (correctly tied to actual connect/disconnect lifecycle, restarts cleanly on reconnect) and is sufficient on its own.

### 🟢 Not reviewed this batch, no outstanding items depend on it

- `config/index.js` wasn't included in this batch (no changes flagged that required seeing it), and nothing in the tracker is currently blocked on it. Treating it as unchanged from the last-seen version.

---

## Summary — Full audit complete, consolidated action list

All four batches reviewed. Here's everything still open, in priority order:

1. **🔴 `claimTicket` doesn't catch `ConcurrencyError` from `assignTicket`** (Batch 2) — the one gap in the core Scenario 1 fix; a lost claim race currently produces a raw 500 instead of a clean 409.
2. **🔴 `autoHoldTicket` nulls `agent_id`** (Batch 3) — regression of a bug already fixed once elsewhere; breaks sticky routing and hides the ticket from the agent's On-Hold tab.
3. **🟡 Phase 2 auto-close (`autoCloseStaleTicket`) skips `sendTicketClosed`** (Batch 3) — customers never get notified when their ticket auto-closes after 24h silence. (`updateAvgHandleTime` skip is fine to leave as-is.)
4. **🟡 Duplicate agent heartbeat** (Batch 4) — harmless but wasteful; remove the one in `AgentDashboard.jsx`, keep `useSocket.js`'s.
5. **🟡 `joinAgentToTicketRoom`/`joinCustomerToTicketRoom` changed from `socketsJoin` to `fetchSockets()`+loop** (Batch 2) — confirm intentional; minor efficiency regression under load if not.
6. **🟡 Minor consistency:** `matchOrEnqueue` and `routeStickyTicket` don't distinguish `ConcurrencyError` in their catch blocks the way `assignNextInQueue`/`routePendingTicket` now do (Batch 2) — low-risk, cosmetic logging consistency only.
7. **🟢 Cleanup, no functional impact:** dead `findSlaBreachedTickets` (Batch 1), dead `escalateTicket`-adjacent enum value, dead `CLOSE_MINUTES` var in `autoCloseWorker.js` (Batch 3), dead `getUserNotificationPref` in `notificationService.js` (Batch 2), stray unused `getQueueMembers()` fetch in the customer-disconnect socket handler (Batch 2).

Items 1–3 are worth fixing before the load test — they're genuine correctness/UX gaps, not edge-case theorizing. Items 4–7 are safe to defer or batch into the same pass at your discretion.
