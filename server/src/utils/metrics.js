import client from 'prom-client';

const register = new client.Registry();

// Add default metrics (memory, CPU, event loop lag, etc.)
client.collectDefaultMetrics({ register });

// Gauges
export const queueDepth = new client.Gauge({
  name: 'queuedesk_queue_depth',
  help: 'Number of customers currently waiting in the queue',
});

export const activeAgents = new client.Gauge({
  name: 'queuedesk_active_agents',
  help: 'Number of active agents (assigned tickets)',
});

export const idleAgents = new client.Gauge({
  name: 'queuedesk_idle_agents',
  help: 'Number of idle agents available to take tickets',
});

export const availableAgentsSetSize = new client.Gauge({
  name: 'queuedesk_agents_available_set_size',
  help: 'Number of agents in the agents:available set',
});

// Counters
export const ticketClaimConflictsTotal = new client.Counter({
  name: 'queuedesk_ticket_claim_conflicts_total',
  help: 'Total number of ticket claim concurrency conflicts',
});

export const slaEscalationsTotal = new client.Counter({
  name: 'queuedesk_sla_escalations_total',
  help: 'Total number of tickets auto-escalated by the SLA worker',
});

export const ticketsAutoClosedTotal = new client.Counter({
  name: 'queuedesk_tickets_auto_closed_total',
  help: 'Total number of tickets auto-closed due to inactivity',
});

export const ticketsMatchedTotal = new client.Counter({
  name: 'queuedesk_tickets_matched_total',
  help: 'Total number of tickets instantly matched',
});

export const ticketsQueuedTotal = new client.Counter({
  name: 'queuedesk_tickets_queued_total',
  help: 'Total number of tickets that fell back to the queue',
});

export const notificationDeadLetterTotal = new client.Counter({
  name: 'queuedesk_notification_dead_letter_total',
  help: 'Total number of permanently failed notifications (dead-lettered)',
});

// Histograms
export const claimLatencySeconds = new client.Histogram({
  name: 'queuedesk_claim_latency_seconds',
  help: 'Time between ticket creation and agent assignment (seconds)',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300], // 100ms to 5 minutes
});

export const queueUpdateLatencySeconds = new client.Histogram({
  name: 'queuedesk_queue_update_latency_seconds',
  help: 'Latency of queue position broadcast updates (seconds)',
  buckets: [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2], // 10ms to 2s
});

export const emailDeliveryLatencySeconds = new client.Histogram({
  name: 'queuedesk_email_delivery_latency_seconds',
  help: 'Time taken to successfully deliver an email (seconds)',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30], 
});

// Register custom metrics
register.registerMetric(queueDepth);
register.registerMetric(activeAgents);
register.registerMetric(idleAgents);
register.registerMetric(availableAgentsSetSize);
register.registerMetric(ticketClaimConflictsTotal);
register.registerMetric(slaEscalationsTotal);
register.registerMetric(ticketsAutoClosedTotal);
register.registerMetric(ticketsMatchedTotal);
register.registerMetric(ticketsQueuedTotal);
register.registerMetric(notificationDeadLetterTotal);
register.registerMetric(claimLatencySeconds);
register.registerMetric(queueUpdateLatencySeconds);
register.registerMetric(emailDeliveryLatencySeconds);

export default register;
