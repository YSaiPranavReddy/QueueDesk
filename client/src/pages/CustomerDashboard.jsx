/**
 * CustomerDashboard — Premium UI v2
 */
import { useState, useEffect, useCallback } from 'react';
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

  const [queueInfo,     setQueueInfo]     = useState(null);
  const [matched,       setMatched]       = useState(null);
  const [activeTab,     setActiveTab]     = useState('tickets');
  const [activeTicketId, setActiveTicketId] = useState(null);
  const [unreadCounts,  setUnreadCounts]  = useState({});

  const myActiveTickets    = tickets.filter(t => t.status !== 'closed' && t.status !== 'pending');
  const myCompletedTickets = tickets.filter(t => t.status === 'closed');
  const totalUnread        = Object.values(unreadCounts).reduce((sum, c) => sum + c, 0);

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

  useEffect(() => {
    if (!socket) return;
    socket.on('queue:position', ({ position, estimatedWaitMs }) => {
      setQueueInfo({ position, estimatedWaitMs });
      setMatched(null);
    });
    socket.on('ticket:matched', ({ ticketId, agentName }) => {
      setMatched({ ticketId, agentName });
      setQueueInfo(null);
      fetchTickets();
      socket.emit('chat:join', { ticketId });
      setActiveTab('chats');
      setActiveTicketId(ticketId);
      setUnreadCounts(prev => ({ ...prev, [ticketId]: 0 }));
    });
    socket.on('chat:message', ({ message }) => {
      const isFromOther    = message.sender_id !== user?.id;
      const isNotCurrentChat = message.ticket_id !== activeTicketId || activeTab !== 'chats';
      if (isFromOther && isNotCurrentChat) {
        setUnreadCounts(prev => ({
          ...prev,
          [message.ticket_id]: (prev[message.ticket_id] || 0) + 1,
        }));
      }
    });
    socket.on('ticket:closed',  () => fetchTickets());
    socket.on('ticket:on_hold', () => fetchTickets());
    return () => {
      socket.off('queue:position');
      socket.off('ticket:matched');
      socket.off('chat:message');
      socket.off('ticket:closed');
      socket.off('ticket:on_hold');
    };
  }, [socket, fetchTickets, activeTicketId, activeTab, user?.id]);

  const openChat = ticketId => {
    setActiveTicketId(ticketId);
    setUnreadCounts(prev => ({ ...prev, [ticketId]: 0 }));
  };

  const handleSubmit = async e => {
    e.preventDefault();
    if (!form.subject.trim()) return;
    setCreating(true);
    setError('');
    try {
      const { data } = await ticketApi.create(form);
      setForm({ subject: '' });
      setShowForm(false);
      if (data.match?.matched) {
        setMatched({ ticketId: data.ticket.id, agentName: 'an agent' });
        setActiveTab('chats');
        setActiveTicketId(data.ticket.id);
        setUnreadCounts(prev => ({ ...prev, [data.ticket.id]: 0 }));
      }
      await fetchTickets();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create ticket.');
    } finally {
      setCreating(false);
    }
  };

  /* ── Chat list item ── */
  const ChatListItem = ({ t }) => {
    const unread   = unreadCounts[t.id] || 0;
    const isActive = activeTicketId === t.id;
    const isClosed = t.status === 'closed';
    return (
      <button
        key={t.id}
        onClick={() => openChat(t.id)}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.625rem',
          width: '100%', padding: '0.625rem 0.75rem',
          background: isActive ? 'rgba(59,130,246,0.12)' : unread > 0 ? 'rgba(59,130,246,0.05)' : 'transparent',
          border: isActive ? '1px solid rgba(59,130,246,0.3)' : unread > 0 ? '1px solid rgba(59,130,246,0.18)' : '1px solid transparent',
          borderRadius: '10px', cursor: 'pointer', textAlign: 'left',
          transition: 'all 0.15s ease', opacity: isClosed ? 0.6 : 1,
        }}
      >
        {/* Avatar */}
        <div style={{
          width: 36, height: 36, borderRadius: 8, flexShrink: 0,
          background: isClosed
            ? 'linear-gradient(135deg,#334155,#475569)'
            : 'linear-gradient(135deg,#2563eb,#60a5fa)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '0.875rem', color: '#fff',
        }}>
          🎧
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: '0.8125rem', fontWeight: unread > 0 ? 700 : 500,
            color: isActive ? 'var(--brand-400)' : 'var(--text-primary)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {t.agent_name || 'Support Agent'}
          </div>
          <div style={{
            fontSize: '0.72rem', color: 'var(--text-muted)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {t.subject}
          </div>
        </div>
        {unread > 0 && (
          <span style={{
            background: 'var(--brand-500)', color: '#fff',
            borderRadius: '50%', minWidth: 20, height: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.68rem', fontWeight: 700, flexShrink: 0,
          }}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="dash-layout">
      {/* ── Sidebar ── */}
      <aside className="dash-sidebar">
        <div className="dash-logo">
          <img src="/logo.png" alt="QueueDesk" className="landing-logo-image" />
          <span className="landing-brand-name">Queue<span className="landing-brand-name-accent">Desk</span></span>
        </div>

        <nav className="dash-nav">
          <button
            className={`dash-nav-item ${activeTab === 'tickets' ? 'active' : ''}`}
            onClick={() => setActiveTab('tickets')}
          >
            <span>🎫</span> My Tickets
            {tickets.length > 0 && (
              <span className="badge badge-blue" style={{ marginLeft: 'auto', fontSize: '0.68rem' }}>{tickets.length}</span>
            )}
          </button>
          <button
            className={`dash-nav-item ${activeTab === 'chats' ? 'active' : ''}`}
            onClick={() => setActiveTab('chats')}
          >
            <span>💬</span> My Chats
            {totalUnread > 0 && (
              <span style={{
                marginLeft: 'auto', background: 'var(--brand-500)', color: '#fff',
                borderRadius: '50%', minWidth: 20, height: 20,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.68rem', fontWeight: 700,
              }}>
                {totalUnread > 99 ? '99+' : totalUnread}
              </span>
            )}
          </button>
        </nav>

        <div style={{ flex: 1 }} />

        {/* Email prefs */}
        <div className="pref-row">
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Email Alerts</span>
          <label className="pref-toggle">
            <input
              type="checkbox"
              checked={user?.notify_email ?? true}
              onChange={async e => {
                const v = e.target.checked;
                setUser(prev => ({ ...prev, notify_email: v }));
                try { await authApi.updatePreferences({ notify_email: v }); }
                catch { setUser(prev => ({ ...prev, notify_email: !v })); }
              }}
            />
            <span className="pref-toggle-track" />
            <span className="pref-toggle-thumb" />
          </label>
        </div>

        {/* User */}
        <div className="dash-user">
          <div className="dash-user-avatar">{user?.name?.[0]?.toUpperCase()}</div>
          <div className="dash-user-info">
            <span className="dash-user-name">{user?.name}</span>
            <span className="dash-user-role badge badge-blue">Customer</span>
          </div>
          <button className="dash-logout-btn" id="logout-btn" onClick={logout} title="Logout">↪</button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="dash-main" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>

        {/* ── TICKETS TAB ── */}
        {activeTab === 'tickets' && (
          <div style={{ overflowY: 'auto', flexGrow: 1 }}>
            <div className="dash-page-header">
              <div>
                <div className="dash-page-title">My Support Tickets</div>
                <div className="dash-page-subtitle">
                  {tickets.length} ticket{tickets.length !== 1 ? 's' : ''}
                  {tickets.filter(t => t.status === 'pending').length > 0 &&
                    ` · ${tickets.filter(t => t.status === 'pending').length} waiting in queue`}
                </div>
              </div>
              <button id="new-ticket-btn" className="btn btn-primary" onClick={() => setShowForm(v => !v)}>
                {showForm ? '✕ Cancel' : '+ New Ticket'}
              </button>
            </div>

            {/* Banners */}
            {matched && (
              <div className="queue-banner queue-banner-matched animate-fadeUp" style={{ marginBottom: '1rem' }}>
                <span className="queue-banner-icon">✅</span>
                <div>
                  <div className="font-semibold">You're connected!</div>
                  <div className="text-sm" style={{ opacity: 0.8 }}>Matched with {matched.agentName}. Head to My Chats to begin.</div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => { setActiveTab('chats'); setActiveTicketId(matched.ticketId); }}>
                  Open Chat →
                </button>
              </div>
            )}

            {queueInfo && !matched && (
              <div className="queue-banner animate-fadeUp" style={{ marginBottom: '1rem' }}>
                <span className="queue-banner-icon">⏳</span>
                <div style={{ flex: 1 }}>
                  <div className="font-semibold">You're #{queueInfo.position} in queue</div>
                  <div className="text-sm" style={{ opacity: 0.8 }}>
                    Estimated wait: ~{Math.round(queueInfo.estimatedWaitMs / 60000)} min
                  </div>
                </div>
                {/* Mini progress bar */}
                <div style={{ width: 80, height: 6, background: 'rgba(245,158,11,0.15)', borderRadius: 99, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${Math.min(100, 100 / queueInfo.position)}%`, background: '#f59e0b', borderRadius: 99, transition: 'width 1s ease' }} />
                </div>
              </div>
            )}

            {/* New ticket form */}
            {showForm && (
              <div className="card animate-fadeUp" style={{ borderColor: 'rgba(59,130,246,.25)', marginBottom: '1rem' }}>
                <h3 className="font-semibold" style={{ marginBottom: '1rem' }}>Submit a support request</h3>
                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
                  <div className="form-group">
                    <label className="form-label">Subject</label>
                    <input
                      id="ticket-subject"
                      className="form-input"
                      placeholder="Describe your issue briefly…"
                      value={form.subject}
                      onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
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
              <div className="dash-coming-soon">
                <div className="coming-soon-icon">🎫</div>
                <h3 className="font-semibold">No tickets yet</h3>
                <p className="text-secondary text-sm">Submit your first support request above.</p>
              </div>
            ) : (
              <div className="ticket-list">
                {tickets.map(t => (
                  <div key={t.id} className="ticket-row animate-fadeUp" data-priority={t.priority}>
                    <div className="ticket-row-left">
                      <span className={`badge ${STATUS_BADGE[t.status] || 'badge-blue'}`}>{t.status}</span>
                      <div>
                        <div className="ticket-subject">{t.subject}</div>
                        {t.agent_name && <div className="ticket-meta">Agent: {t.agent_name}</div>}
                      </div>
                    </div>
                    <div className="ticket-row-right">
                      <span className={`badge badge-${t.priority === 'urgent' ? 'red' : t.priority === 'high' ? 'yellow' : 'blue'}`}>
                        {t.priority}
                      </span>
                      <span className="text-muted text-xs">{new Date(t.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── CHATS TAB ── */}
        {activeTab === 'chats' && (
          <div style={{ display: 'flex', gap: '1rem', flexGrow: 1, minHeight: 0 }}>
            {/* Sidebar */}
            <div style={{
              width: '280px', flexShrink: 0,
              background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)', overflowY: 'auto',
              display: 'flex', flexDirection: 'column', padding: '0.875rem',
            }}>
              <div className="chat-sidebar-section-label">Active Chats</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '1rem' }}>
                {myActiveTickets.length === 0
                  ? <p className="text-xs text-muted" style={{ padding: '0.5rem 0' }}>No active conversations</p>
                  : myActiveTickets.map(t => <ChatListItem key={t.id} t={t} />)
                }
              </div>

              <div className="chat-sidebar-section-label">Completed</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {myCompletedTickets.length === 0
                  ? <p className="text-xs text-muted" style={{ padding: '0.5rem 0' }}>No completed chats</p>
                  : myCompletedTickets.map(t => <ChatListItem key={t.id} t={t} />)
                }
              </div>
            </div>

            {/* Chat panel */}
            <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              {activeTicketId ? (
                <div className="card" style={{ padding: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', borderBottom: '1px solid var(--border-subtle)' }}>
                    <div>
                      <div className="font-semibold text-sm">{tickets.find(t => t.id === activeTicketId)?.subject}</div>
                      <div className="text-xs text-muted">
                        {tickets.find(t => t.id === activeTicketId)?.agent_name
                          ? `Agent: ${tickets.find(t => t.id === activeTicketId)?.agent_name}`
                          : 'Waiting for agent…'}
                      </div>
                    </div>
                    <button className="btn btn-ghost btn-sm" onClick={() => setActiveTicketId(null)}>✕ Close</button>
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
                <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '0.75rem' }}>
                  <div style={{ fontSize: '2.5rem', opacity: 0.4 }}>💬</div>
                  <div className="text-secondary text-sm">Select a conversation to view</div>
                  {myActiveTickets.length === 0 && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setActiveTab('tickets')}>
                      Submit a ticket →
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
