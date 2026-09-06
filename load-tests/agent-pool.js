const axios = require('axios');
const { io } = require('socket.io-client');

const API_BASE = 'http://localhost:8080/api';
const NUM_AGENTS = 5;

// Generate deterministic email for agents
const runId = Date.now();
const agentEmail = (i) => `agent_${runId}_${i}@example.com`;

async function spawnAgent(id) {
  const email = agentEmail(id);
  const password = 'password123';
  const name = `Agent ${id}`;

  let token;
  try {
    const regRes = await axios.post(`${API_BASE}/auth/register`, { name, email, password, role: 'agent' });
    token = regRes.data.accessToken;
    console.log(`[Agent ${id}] Registered successfully`);
  } catch (err) {
    console.error(`[Agent ${id}] Failed to register`, err?.response?.data || err.message);
    return;
  }

  // Connect WebSocket just to stay online (some guards might check online status)
  const socket = io('http://localhost:8080', {
    auth: { token },
    transports: ['websocket']
  });

  socket.on('connect', async () => {
    console.log(`[Agent ${id}] WS Connected`);
    
    // Ping to stay alive
    setInterval(() => {
      socket.emit('ping:agent');
    }, 30000);

    // Mark as busy so we can claim, but auto-matcher ignores us
    try {
      await axios.patch(`${API_BASE}/agents/status`, { status: 'busy' }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      console.log(`[Agent ${id}] Marked busy`);
    } catch (err) {
      console.error(`[Agent ${id}] Failed to mark busy:`, err?.response?.data || err.message);
    }

    // Poll for pending tickets to simulate manual claim races
    setInterval(async () => {
      try {
        const res = await axios.get(`${API_BASE}/tickets?status=pending`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        const tickets = res.data.tickets || [];
        if (tickets.length > 0) {
          // Attempt to claim ALL tickets we see simultaneously to FORCE race conditions!
          await Promise.all(tickets.map(async (ticket) => {
            const ticketToClaim = ticket.id;
            try {
              await axios.post(`${API_BASE}/tickets/${ticketToClaim}/claim`, {}, {
                headers: { Authorization: `Bearer ${token}` }
              });
              console.log(`[Agent ${id}] Successfully claimed ticket ${ticketToClaim}`);
              
              // Work on it for 1s then close
              setTimeout(async () => {
                try {
                  await axios.patch(`${API_BASE}/tickets/${ticketToClaim}/close`, {}, {
                    headers: { Authorization: `Bearer ${token}` }
                  });
                  console.log(`[Agent ${id}] Closed ticket: ${ticketToClaim}`);
                } catch (e) { }
              }, 1000);
              
            } catch (err) {
              // Expected if another agent beat us!
              if (err.response && err.response.status === 409) {
                console.log(`[Agent ${id}] Conflict! Ticket ${ticketToClaim} already claimed!`);
              } else if (err.response && [429, 400, 403].includes(err.response.status)) {
                // Failed due to limit or offline
              } else {
                console.error(`[Agent ${id}] Error claiming:`, err.message);
              }
            }
          }));
        }
      } catch (err) {
        console.error(`[Agent ${id}] Poll error:`, err.message);
      }
    }, 500); // Very aggressive polling to ensure races
  });

  socket.on('disconnect', () => {
    console.log(`[Agent ${id}] WS Disconnected`);
  });
}

async function run() {
  console.log(`Starting ${NUM_AGENTS} agents...`);
  for (let i = 1; i <= NUM_AGENTS; i++) {
    spawnAgent(i);
  }
}

run();
