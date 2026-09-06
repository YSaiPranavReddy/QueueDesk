/**
 * CustomerDashboard — M4 updated
 * Live: queue position banner + ticket:matched notification via Socket.IO
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { authApi } from '../api/auth.js';
import { ticketApi } from '../api/tickets.js';
import { useSocket } from '../hooks/useSocket.js';
import ChatPanel from '../components/ChatPanel.jsx';
import './Dashboard.css';

const STATUS_BADGE = {
  pending:   'badge-yellow',
  assigned:  'badge-blue',
  open:      'badge-blue',
  escalated: 'badge-red',
  closed:    'badge-green',
};

export default function CustomerDashboard() {
  const { user, setUser, logout } = useAuth();

  const [tickets,  setTickets]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [creating, setCreating] = useState(false);
  const [form,     setForm]     = useState({ subject: '' });
  const [showForm, setShowForm] = useState(false);
  const [error,    setError]    = useState('');

  // Live queue state
  const [queueInfo, setQueueInfo]   = useState(null);  // { position, estimatedWaitMs }
  const [matched,   setMatched]     = useState(null);  // { ticketId, agentName }
  const [activeTab, setActiveTab]   = useState('tickets'); // 'tickets' | 'chats'
  const [activeTicketId, setActiveTicketId] = useState(null);
  const [unreadCounts, setUnreadCounts] = useState({});

  // Tickets for chats view
  const myActiveTickets = tickets.filter(t => t.status !== 'closed' && t.status !== 'pending'); // only assigned/open/escalated have chats
  const myCompletedTickets = tickets.filter(t => t.status === 'closed');

  const { socket } = useSocket();

  const fetchTickets = useCallback(async () => {
    try {
      const { data } = await ticketApi.list();
      setTickets(data.tickets);
    } catch {
      setError('Failed to load tickets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTickets(); }, [fetchTickets]);

  // ── Socket: listen for live events ──────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    socket.on('queue:position', ({ position, estimatedWaitMs }) => {
      setQueueInfo({ position, estimatedWaitMs });
      setMatched(null);
    });
    socket.on('ticket:matched', ({ ticketId, agentName }) => {
      setMatched({ ticketId, agentName });
      setQueueInfo(null);
      fetchTickets(); // refresh list to show assigned status
      socket.emit('chat:join', { ticketId }); // Auto-join room for background notifications
      setActiveTab('chats');
      setActiveTicketId(ticketId);
      setUnreadCounts((prev) => ({ ...prev, [ticketId]: 0 }));
    });
    socket.on('chat:message', ({ message }) => {
      if (message.ticket_id !== activeTicketId || activeTab !== 'chats') {
        setUnreadCounts((prev) => ({
          ...prev,
          [message.ticket_id]: (prev[message.ticket_id] || 0) + 1,
        }));
      }
    });
    socket.on('ticket:closed', () => {
      fetchTickets();
    });
    return () => {
      socket.off('queue:position');
      socket.off('ticket:matched');
      socket.off('chat:message');
      socket.off('ticket:closed');
    };
  }, [socket, fetchTickets, activeTicketId, activeTab]);

  const openChat = (ticketId) => {
    setActiveTicketId(ticketId);
    setUnreadCounts((prev) => ({ ...prev, [ticketId]: 0 }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.subject.trim()) return;
    setCreating(true);
    setError('');
    try {
      const { data } = await ticketApi.create(form);
      setForm({ subject: '' });
      setShowForm(false);
      // If already matched instantly, no queue widget needed
      if (data.match?.matched) {
        setMatched({ ticketId: data.ticket.id, agentName: 'an agent' });
        setActiveTab('chats');
        setActiveTicketId(data.ticket.id);
        setUnreadCounts((prev) => ({ ...prev, [data.ticket.id]: 0 }));
      }
      await fetchTickets();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create ticket.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="dash-layout">
      <aside className="dash-sidebar">
        <div className="dash-logo">
          <img src="/logo.png" alt="QueueDesk logo" className="landing-logo-image" />
          <span className="landing-brand-name">Queue<span className="landing-brand-name-accent">Desk</span></span>
        </div>
        <nav className="dash-nav">
          <button 
            className={`dash-nav-item ${activeTab === 'tickets' ? 'active' : ''}`} 
            onClick={() => setActiveTab('tickets')}
            style={{ width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
          >
            <span>🎫</span> My Tickets
          </button>
          <button 
            className={`dash-nav-item ${activeTab === 'chats' ? 'active' : ''}`} 
            onClick={() => setActiveTab('chats')}
            style={{ width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}
          >
            <span>💬</span> My Chats
          </button>
        </nav>
        <div className="dash-user">
          <div className="dash-user-avatar">{user?.name?.[0]?.toUpperCase()}</div>
          <div className="dash-user-info">
            <span className="dash-user-name">{user?.name}</span>
            <span className="dash-user-role badge badge-blue">Customer</span>
          </div>
          <button className="dash-logout-btn" id="logout-btn" onClick={logout} title="Logout">↪</button>
        </div>
        
        {/* M10: Notification Preferences Toggle */}
        <div style={{ marginTop: 'auto', padding: '1rem', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="text-sm font-medium">Email Alerts</span>
          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
            <input 
              type="checkbox" 
              checked={user?.notify_email ?? true}
              onChange={async (e) => {
                const newVal = e.target.checked;
                setUser(prev => ({ ...prev, notify_email: newVal }));
                try {
                  await authApi.updatePreferences({ notify_email: newVal });
                } catch (err) {
                  console.error('Failed to update preferences', err);
                  setUser(prev => ({ ...prev, notify_email: !newVal })); // revert on error
                }
              }}
              style={{ accentColor: 'var(--primary)', width: '16px', height: '16px' }}
            />
          </label>
        </div>
      </aside>

      <main className="dash-main" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
        
        {activeTab === 'tickets' ? (
          <div style={{ overflowY: 'auto', flexGrow: 1 }}>
            {/* Header */}
            <div className="dash-page-header">
              <div>
                <h1 className="text-2xl font-bold">My Support Tickets</h1>
                <p className="text-secondary text-sm" style={{ marginTop: '.25rem' }}>
                  {tickets.length} ticket{tickets.length !== 1 ? 's' : ''}
                </p>
              </div>
              <button
                id="new-ticket-btn"
                className="btn btn-primary"
                onClick={() => setShowForm((v) => !v)}
              >
                {showForm ? '✕ Cancel' : '+ New Ticket'}
              </button>
            </div>

        {/* Live: matched banner */}
        {matched && (
          <div className="queue-banner queue-banner-matched animate-fadeUp">
            <span className="queue-banner-icon">✅</span>
            <div>
              <div className="font-semibold">You&apos;re connected!</div>
              <div className="text-sm">You&apos;ve been matched with {matched.agentName}.</div>
            </div>
          </div>
        )}

        {/* Live: queue position banner */}
        {queueInfo && !matched && (
          <div className="queue-banner animate-fadeUp">
            <span className="queue-banner-icon">⏳</span>
            <div>
              <div className="font-semibold">You&apos;re #{queueInfo.position} in queue</div>
              <div className="text-sm">
                Est. wait: ~{Math.round(queueInfo.estimatedWaitMs / 60000)} min
              </div>
            </div>
          </div>
        )}

        {/* New ticket form */}
        {showForm && (
          <div className="card animate-fadeUp" style={{ borderColor: 'rgba(59,130,246,.3)' }}>
            <h3 className="font-semibold" style={{ marginBottom: '1rem' }}>Submit a support request</h3>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '.875rem' }}>
              <div className="form-group">
                <label className="form-label">Subject</label>
                <input
                  id="ticket-subject"
                  className="form-input"
                  placeholder="Describe your issue briefly…"
                  value={form.subject}
                  onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                  required
                />
              </div>
              {error && <p className="text-error text-sm">{error}</p>}
              <button id="submit-ticket-btn" type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? <><div className="spinner" /> Submitting…</> : 'Submit Ticket'}
              </button>
            </form>
          </div>
        )}

        {/* Ticket list */}
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <div className="spinner" style={{ width: 28, height: 28 }} />
          </div>
        ) : tickets.length === 0 ? (
          <div className="dash-coming-soon card">
            <div className="coming-soon-icon">🎫</div>
            <h3 className="font-semibold">No tickets yet</h3>
            <p className="text-secondary text-sm">Submit your first support request above.</p>
          </div>
        ) : (
          <div className="ticket-list">
            {tickets.map((t) => (
              <div key={t.id} className="ticket-row card animate-fadeUp">
                <div className="ticket-row-left">
                  <span className={`badge ${STATUS_BADGE[t.status] || 'badge-blue'}`}>
                    {t.status}
                  </span>
                  <span className="ticket-subject">{t.subject}</span>
                </div>
                <div className="ticket-row-right">
                  <span className={`badge badge-${t.priority === 'urgent' ? 'red' : t.priority === 'high' ? 'yellow' : 'blue'}`}>
                    {t.priority}
                  </span>
                  <span className="text-muted text-xs">
                    {new Date(t.created_at).toLocaleDateString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
          </div>
        ) : (
          <div className="chats-view" style={{ display: 'flex', gap: '1.5rem', flexGrow: 1, minHeight: 0 }}>
            {/* Chat Sidebar (Active & Completed) */}
            <div className="chat-sidebar card" style={{ width: '320px', flexShrink: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
              <h4 className="font-semibold text-sm" style={{ marginBottom: '.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active Chats</h4>
              {myActiveTickets.length === 0 ? (
                <p className="text-muted text-xs" style={{ marginBottom: '1.5rem' }}>No active conversations</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem' }}>
                  {myActiveTickets.map((t) => (
                    <button
                      key={t.id}
                      className={`chat-list-item ${activeTicketId === t.id ? 'active' : ''}`}
                      onClick={() => openChat(t.id)}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        width: '100%', padding: '0.75rem',
                        background: activeTicketId === t.id ? 'var(--primary-light)' : 'var(--bg-card-alt)',
                        color: activeTicketId === t.id ? 'var(--primary-dark)' : 'var(--text-primary)',
                        border: activeTicketId === t.id ? '1px solid var(--primary)' : '1px solid var(--border)',
                        borderRadius: '6px', cursor: 'pointer', textAlign: 'left',
                        fontWeight: activeTicketId === t.id ? '600' : 'normal',
                        transition: 'all 0.2s ease'
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        <span className="text-sm truncate" style={{ color: 'inherit' }}>{t.agent_name || 'Agent'} : {t.subject}</span>
                      </div>
                      {unreadCounts[t.id] > 0 && (
                        <span className="badge badge-red">{unreadCounts[t.id]}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              <h4 className="font-semibold text-sm" style={{ marginBottom: '.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Completed Tasks</h4>
              {myCompletedTickets.length === 0 ? (
                <p className="text-muted text-xs">No completed chats</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {myCompletedTickets.map((t) => (
                    <button
                      key={t.id}
                      className={`chat-list-item ${activeTicketId === t.id ? 'active' : ''}`}
                      onClick={() => openChat(t.id)}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        width: '100%', padding: '0.75rem',
                        background: activeTicketId === t.id ? 'var(--primary-light)' : 'transparent',
                        color: activeTicketId === t.id ? 'var(--primary-dark)' : 'var(--text-muted)',
                        border: '1px solid transparent',
                        borderRadius: '6px', cursor: 'pointer', textAlign: 'left',
                        transition: 'all 0.2s ease'
                      }}
                    >
                      <span className="text-sm truncate" style={{ color: 'inherit' }}>{t.agent_name || 'Agent'} : {t.subject}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Chat Panel */}
            <div className="chat-content" style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              {activeTicketId ? (
                <div className="card" style={{ padding: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', borderBottom: '1px solid var(--border-subtle)' }}>
                    <span className="font-semibold text-sm">
                      Chat — {tickets.find(t => t.id === activeTicketId)?.subject}
                    </span>
                    <button className="btn btn-ghost btn-sm" onClick={() => setActiveTicketId(null)}>✕ Close chat</button>
                  </div>
                  <div style={{ flexGrow: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <ChatPanel
                      ticketId={activeTicketId}
                      socket={socket}
                      currentUserId={user?.id}
                      currentUserRole="customer"
                      ticketStatus={tickets.find(t => t.id === activeTicketId)?.status}
                    />
                  </div>
                </div>
              ) : (
                <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>💬</div>
                    <div>Select a chat from the sidebar to view</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
