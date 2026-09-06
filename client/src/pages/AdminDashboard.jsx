/**
 * AdminDashboard — M2.T5
 * Real: agent list from API.
 * Observability metrics added in M12.
 */
import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { agentApi, ticketApi } from '../api/tickets.js';
import './Dashboard.css';

export default function AdminDashboard() {
  const { user, logout } = useAuth();

  const [agents,  setAgents]  = useState([]);
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [agentRes, ticketRes] = await Promise.all([
          agentApi.list(),
          ticketApi.list(),
        ]);
        setAgents(agentRes.data.agents);
        setTickets(ticketRes.data.tickets);
      } catch {
        // handle in M12 with proper error states
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const pending   = tickets.filter((t) => t.status === 'pending').length;
  const escalated = tickets.filter((t) => t.status === 'escalated').length;
  const closed    = tickets.filter((t) => t.status === 'closed').length;

  return (
    <div className="dash-layout">
      <aside className="dash-sidebar">
        <div className="dash-logo">
          <img src="/logo.png" alt="QueueDesk logo" className="landing-logo-image" />
          <span className="landing-brand-name">Queue<span className="landing-brand-name-accent">Desk</span></span>
        </div>
        <nav className="dash-nav">
          <a href="#" className="dash-nav-item active"><span>📊</span> Overview</a>
          <a href="#" className="dash-nav-item"><span>🧑‍💼</span> Agents</a>
          <a href="#" className="dash-nav-item"><span>🎫</span> All Tickets</a>
          <a href="#" className="dash-nav-item"><span>⚙️</span> Settings</a>
        </nav>
        <div className="dash-user">
          <div className="dash-user-avatar admin-avatar">{user?.name?.[0]?.toUpperCase()}</div>
          <div className="dash-user-info">
            <span className="dash-user-name">{user?.name}</span>
            <span className="dash-user-role badge badge-yellow">Admin</span>
          </div>
          <button className="dash-logout-btn" id="logout-btn-admin" onClick={logout} title="Logout">↪</button>
        </div>
      </aside>

      <main className="dash-main">
        {/* Stats */}
        <div className="dash-stats-row">
          {[
            { label: 'Total Agents',  value: agents.length, icon: '🎧' },
            { label: 'In Queue',      value: pending,        icon: '⏳' },
            { label: 'Escalated',     value: escalated,      icon: '🚨' },
            { label: 'Closed',        value: closed,         icon: '✅' },
          ].map(({ label, value, icon }) => (
            <div key={label} className="dash-stat-card card">
              <div className="dash-stat-icon">{icon}</div>
              <div className="dash-stat-value">{loading ? '—' : value}</div>
              <div className="dash-stat-label text-secondary text-sm">{label}</div>
            </div>
          ))}
        </div>

        {/* Agent roster */}
        <div className="card">
          <h3 className="font-semibold" style={{ marginBottom: '1rem' }}>Agent Roster</h3>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
              <div className="spinner" style={{ width: 24, height: 24 }} />
            </div>
          ) : agents.length === 0 ? (
            <p className="text-secondary text-sm">No agents registered yet.</p>
          ) : (
            <div className="agent-roster">
              {agents.map((a) => (
                <div key={a.id} className="agent-row">
                  <div className="dash-user-avatar agent-avatar">{a.name[0].toUpperCase()}</div>
                  <div style={{ flex: 1 }}>
                    <div className="font-medium text-sm">{a.name}</div>
                    <div className="text-muted text-xs">{a.email}</div>
                  </div>
                  {/* Redis status merged in M3 */}
                  <span className="badge badge-blue">{a.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="dash-coming-soon card">
          <div className="coming-soon-icon">📈</div>
          <h3 className="font-semibold">Live metrics endpoint — M12</h3>
          <p className="text-secondary text-sm">Queue depth, claim latency, and SLA escalation counts.</p>
        </div>
      </main>
    </div>
  );
}
