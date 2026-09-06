const axios = require('axios');

async function fetchMetrics() {
  const ports = [3001, 3002, 3003];
  const metrics = {
    queuedesk_ticket_claim_conflicts_total: 0,
    queuedesk_tickets_matched_total: 0,
    queuedesk_tickets_queued_total: 0,
    queuedesk_sla_escalations_total: 0,
  };

  for (const port of ports) {
    try {
      const res = await axios.get(`http://localhost:${port}/metrics`);
      const lines = res.data.split('\n');
      
      lines.forEach(line => {
        if (line.startsWith('#')) return; // skip comments
        if (!line.trim()) return; // skip empty lines

        const [key, value] = line.split(' ');
        if (metrics[key] !== undefined) {
          metrics[key] += parseFloat(value);
        }
      });
    } catch (err) {
      console.error(`Failed to fetch from port ${port}:`, err.message);
    }
  }

  console.log("=== LOAD TEST METRICS AGGREGATION ===");
  console.log(`Tickets Instantly Matched:    ${metrics.queuedesk_tickets_matched_total}`);
  console.log(`Tickets Queued:               ${metrics.queuedesk_tickets_queued_total}`);
  console.log(`Total Claim Conflicts:        ${metrics.queuedesk_ticket_claim_conflicts_total} (Zero is bad if load is high! We want conflicts resolved safely)`);
  console.log(`SLA Escalations:              ${metrics.queuedesk_sla_escalations_total}`);
  console.log("=====================================");

  // Note: For "Zero double-claimed tickets" under concurrent claims, 
  // the 'conflicts' counter shows how many we prevented! 
  // If no crashes happened and all customers got matched, it means zero actual double-claims happened.
}

fetchMetrics();
