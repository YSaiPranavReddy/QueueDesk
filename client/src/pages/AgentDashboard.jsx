/**
 * AgentDashboard — Premium UI v2
 */
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { authApi } from '../api/auth.js';
import { ticketApi, agentApi } from '../api/tickets.js';
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

const AGENT_STATUS_COLORS = {
  available: '#10b981',
  busy:      '#f59e0b',
  offline:   '#475569',
};

export default function AgentDashboard() {
  const { user, setUser, logout } = useAuth();

  const [tickets,       setTickets]       = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [agentStatus,   setAgentStatus]   = useState(() => localStorage.getItem('agentStatus') || 'offline');
  const [statusLoading, setStatusLoading] = useState(false);
  const [filter,        setFilter]        = useState('');
  const [toast,         setToast]         = useState(null);
  const [claimingId,    setClaimingId]    = useState(null);
  const [activeTab,     setActiveTab]     = useState('queue');
  const [activeTicketId, setActiveTicketId] = useState(null);
  const [unreadCounts,  setUnreadCounts]  = useState({});
  const [notifications, setNotifications] = useState([]);
  const [showNotifPanel, setShowNotifPanel] = useState(false);

  const { socket } = useSocket();

  const myActiveTickets   = tickets.filter(t => t.agent_id === user?.id && t.status === 'assigned');
  const myOnHoldTickets   = tickets.filter(t => t.agent_id === user?.id && t.status === 'open');
  const myCompletedTickets = tickets.filter(t => t.agent_id === user?.id && t.status === 'closed');

  const fetchTickets = useCallback(async () => {
    try {
      const params = filter ? { status: filter } : {};
      const { data } = await ticketApi.list(params);
      setTickets(data.tickets);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchTickets();
    const interval = setInterval(fetchTickets, 30000);
    return () => clearInterval(interval);
  }, [fetchTickets]);

  useEffect(() => {
    if (!socket) return;

    const handleConnect = async () => {
      if (agentStatus !== 'offline') {
        try { await agentApi.setStatus(agentStatus); } catch (_) {}
      }
    };
    socket.on('connect', handleConnect);

    socket.on('ticket:assigned', ({ ticket }) => {
      setToast({ subject: ticket.subject, ticketId: ticket.id });
      fetchTickets();
      socket.emit('chat:join', { ticketId: ticket.id });
      setTimeout(() => setToast(null), 6000);
    });

    socket.on('ticket:pending', ({ ticket }) => {
      setTickets(prev => prev.some(t => t.id === ticket.id) ? prev : [ticket, ...prev]);
    });

    socket.on('chat:message', ({ message }) => {
      const isFromOther   = message.sender_id !== user?.id;
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
    socket.on('agent:notification', notif => setNotifications(prev => [notif, ...prev]));

    return () => {
      socket.off('connect', handleConnect);
      socket.off('ticket:assigned');
      socket.off('ticket:pending');
      socket.off('chat:message');
      socket.off('ticket:closed');
      socket.off('ticket:on_hold');
      socket.off('agent:notification');
    };
  }, [socket, fetchTickets, activeTicketId, activeTab, agentStatus, user?.id]);

  const openChat = ticketId => {
    setActiveTicketId(ticketId);
    setUnreadCounts(prev => ({ ...prev, [ticketId]: 0 }));
  };

  const handleStatusChange = async newStatus => {
    setStatusLoading(true);
    try {
      await agentApi.setStatus(newStatus);
      setAgentStatus(newStatus);
      localStorage.setItem('agentStatus', newStatus);
    } catch (err) {
      console.error('Failed to change status', err);
    } finally {
      setStatusLoading(false);
    }
  };

  const handleClaim = async ticketId => {
    setClaimingId(ticketId);
    try {
      await ticketApi.claim(ticketId);
      openChat(ticketId);
      setActiveTab('chats');
      await fetchTickets();
    } catch (err) {
      const msg = err.response?.data?.message || 'Could not claim ticket';
      setToast({ subject: msg, isError: true });
      setTimeout(() => setToast(null), 4000);
    } finally {
      setClaimingId(null);
    }
  };

  const pending     = tickets.filter(t => t.status === 'pending').length;
  const myActive    = tickets.filter(t => t.agent_id === user?.id && t.status !== 'closed').length;
  const closed      = tickets.filter(t => t.status === 'closed').length;
  const totalUnread = Object.values(unreadCounts).reduce((sum, c) => sum + c, 0);

  /* ── Chat sidebar list builder ── */
  const ChatListItem = ({ t, isOnHold = false }) => {
    const unread = unreadCounts[t.id] || 0;
    const isActive = activeTicketId === t.id;
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
          transition: 'all 0.15s ease',
        }}
      >
        {/* Avatar */}
        <div style={{
          width: 36, height: 36, borderRadius: 8, flexShrink: 0,
          background: 'linear-gradient(135deg,#7c3aed,#a78bfa)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '0.875rem', fontWeight: 700, color: '#fff',
        }}>
          {t.customer_name?.[0]?.toUpperCase() || '?'}
        </div>
        {/* Text */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: '0.8125rem', fontWeight: unread > 0 ? 700 : 500,
            color: isActive ? 'var(--brand-400)' : 'var(--text-primary)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {t.customer_name}
          </div>
          <div style={{
            fontSize: '0.72rem', color: 'var(--text-muted)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {isOnHold ? '⏸ On Hold — ' : ''}{t.subject}
          </div>
        </div>
        {/* Unread badge */}
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
        {/* Logo */}
        <div className="dash-logo">
          <img src="/logo.png" alt="QueueDesk" className="landing-logo-image" />
          <span className="landing-brand-name">Queue<span className="landing-brand-name-accent">Desk</span></span>
        </div>

        {/* Status panel */}
        <div className="agent-status-panel">
          <div className="agent-status-label">My Status</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            {['available', 'busy', 'offline'].map(s => (
              <button
                key={s}
                id={`status-${s}`}
                className={`agent-status-btn ${agentStatus === s ? 'active' : ''}`}
                style={{ '--dot-color': AGENT_STATUS_COLORS[s] }}
                onClick={() => handleStatusChange(s)}
                disabled={statusLoading}
              >
                <span className="status-dot" />
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Nav */}
        <nav className="dash-nav">
          <button
            className={`dash-nav-item ${activeTab === 'queue' ? 'active' : ''}`}
            onClick={() => { setActiveTab('queue'); setActiveTicketId(null); }}
          >
            <span>📥</span> Ticket Queue
            {pending > 0 && (
              <span className="badge badge-yellow" style={{ marginLeft: 'auto', fontSize: '0.68rem' }}>{pending}</span>
            )}
          </button>
          <button
            className={`dash-nav-item ${activeTab === 'chats' ? 'active' : ''}`}
            onClick={() => { setActiveTab('chats'); setActiveTicketId(null); }}
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
          <button
            className={`dash-nav-item ${activeTab === 'on-hold' ? 'active' : ''}`}
            onClick={() => { setActiveTab('on-hold'); setActiveTicketId(null); }}
          >
            <span>⏸️</span> On Hold
            {myOnHoldTickets.length > 0 && (
              <span className="badge badge-yellow" style={{ marginLeft: 'auto', fontSize: '0.68rem' }}>{myOnHoldTickets.length}</span>
            )}
          </button>
        </nav>

        {/* Notifications */}
        <div style={{ padding: '0 0.25rem', position: 'relative' }}>
          <button
            onClick={() => setShowNotifPanel(!showNotifPanel)}
            className="dash-nav-item"
            style={{ width: '100%' }}
          >
            <span>🔔</span> Notifications
            {notifications.length > 0 && (
              <span className="badge badge-red" style={{ marginLeft: 'auto', fontSize: '0.68rem' }}>{notifications.length}</span>
            )}
          </button>
          {showNotifPanel && (
            <div className="card" style={{
              position: 'absolute', bottom: '110%', left: 0, right: 0,
              zIndex: 10, padding: '0.75rem', maxHeight: '280px', overflowY: 'auto',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <span className="text-sm font-semibold">Reminders</span>
                <button className="btn btn-ghost btn-sm" style={{ fontSize: '0.7rem', padding: '0.15rem 0.5rem' }} onClick={() => setNotifications([])}>Clear</button>
              </div>
              {notifications.length === 0
                ? <p className="text-xs text-muted">No new notifications</p>
                : notifications.map(n => (
                    <div
                      key={n.id}
                      style={{ padding: '0.5rem', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.8125rem', cursor: 'pointer' }}
                      onClick={() => { setActiveTab('on-hold'); openChat(n.ticketId); setShowNotifPanel(false); }}
                    >
                      <div className="font-semibold">{n.subject}</div>
                      <div className="text-muted text-xs">{n.message}</div>
                    </div>
                  ))
              }
            </div>
          )}
        </div>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Email pref toggle */}
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
          <div className="dash-user-avatar agent-avatar">{user?.name?.[0]?.toUpperCase()}</div>
          <div className="dash-user-info">
            <span className="dash-user-name">{user?.name}</span>
            <span className="dash-user-role badge badge-violet">Agent</span>
          </div>
          <button className="dash-logout-btn" id="logout-btn" onClick={logout} title="Logout">↪</button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="dash-main" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>

        {/* Toast */}
        {toast && (
          <div className={`queue-banner ${toast.isError ? '' : 'queue-banner-matched'} animate-fadeUp`} style={{ flexShrink: 0 }}>
            <span className="queue-banner-icon">{toast.isError ? '⚠️' : '🎫'}</span>
            <div style={{ flex: 1 }}>
              <div className="font-semibold">{toast.isError ? 'Error' : 'New ticket assigned!'}</div>
              <div className="text-sm" style={{ opacity: 0.8 }}>{toast.subject}</div>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setToast(null)}>✕</button>
          </div>
        )}

        {/* ── QUEUE TAB ── */}
        {activeTab === 'queue' && (
          <div style={{ overflowY: 'auto', flexGrow: 1 }}>
            <div className="dash-page-header">
              <div>
                <div className="dash-page-title">Ticket Queue</div>
                <div className="dash-page-subtitle">{tickets.length} total • {pending} pending</div>
              </div>
            </div>

            {/* Stats */}
            <div className="dash-stats-row" style={{ marginBottom: '1.25rem' }}>
              {[
                { label: 'In Queue',     value: pending,  icon: '⏳', color: 'yellow' },
                { label: 'My Active',    value: myActive, icon: '🎫', color: 'blue'   },
                { label: 'Closed Today', value: closed,   icon: '✅', color: 'green'  },
              ].map(({ label, value, icon, color }) => (
                <div key={label} className="dash-stat-card">
                  <div className={`dash-stat-icon-wrap ${color}`}>{icon}</div>
                  <div className="dash-stat-body">
                    <div className="dash-stat-value">{value}</div>
                    <div className="dash-stat-label">{label}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Filter tabs */}
            <div className="dash-filter-tabs" style={{ marginBottom: '1rem' }}>
              {[['', 'All'], ['pending', 'Pending'], ['assigned', 'Assigned'], ['escalated', 'Escalated'], ['closed', 'Closed']].map(([val, label]) => (
                <button
                  key={val}
                  className={`dash-filter-tab ${filter === val ? 'active' : ''}`}
                  onClick={() => { setFilter(val); setLoading(true); }}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Ticket list */}
            {loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
                <div className="spinner" style={{ width: 28, height: 28 }} />
              </div>
            ) : tickets.length === 0 ? (
              <div className="dash-coming-soon">
                <div className="coming-soon-icon">📭</div>
                <h3 className="font-semibold">No tickets {filter ? `with status "${filter}"` : 'yet'}</h3>
              </div>
            ) : (
              <div className="ticket-list">
                {tickets.map(t => (
                  <div key={t.id} className="ticket-row animate-fadeUp" data-priority={t.priority}>
                    <div className="ticket-row-left">
                      <span className={`badge ${STATUS_BADGE[t.status] || 'badge-blue'}`}>{t.status}</span>
                      <div>
                        <div className="ticket-subject">{t.subject}</div>
                        <div className="ticket-meta">by {t.customer_name}</div>
                      </div>
                    </div>
                    <div className="ticket-row-right">
                      <span className={`badge badge-${t.priority === 'urgent' ? 'red' : t.priority === 'high' ? 'yellow' : 'blue'}`}>
                        {t.priority}
                      </span>
                      {t.status === 'pending' && (
                        <button
                          id={`claim-${t.id}`}
                          className="btn btn-primary btn-sm"
                          disabled={claimingId === t.id}
                          onClick={() => handleClaim(t.id)}
                        >
                          {claimingId === t.id ? <><div className="spinner" style={{ width: 12, height: 12 }} /> Claiming…</> : 'Claim →'}
                        </button>
                      )}
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

            {/* Chat area */}
            <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              {activeTicketId ? (
                <div className="card" style={{ padding: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', borderBottom: '1px solid var(--border-subtle)' }}>
                    <div>
                      <div className="font-semibold text-sm">{tickets.find(t => t.id === activeTicketId)?.subject}</div>
                      <div className="text-xs text-muted">{tickets.find(t => t.id === activeTicketId)?.customer_name}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      {tickets.find(t => t.id === activeTicketId)?.status === 'assigned' && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={async () => {
                            try { await ticketApi.putOnHold(activeTicketId); fetchTickets(); setActiveTab('on-hold'); }
                            catch { setToast({ subject: 'Failed to put on hold', isError: true }); setTimeout(() => setToast(null), 4000); }
                          }}
                        >
                          ⏸ Hold
                        </button>
                      )}
                      {tickets.find(t => t.id === activeTicketId)?.status !== 'closed' && (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={async () => {
                            try { await ticketApi.close(activeTicketId); fetchTickets(); }
                            catch { setToast({ subject: 'Failed to close ticket', isError: true }); setTimeout(() => setToast(null), 4000); }
                          }}
                        >
                          ✓ Resolve
                        </button>
                      )}
                      <button className="btn btn-ghost btn-sm" onClick={() => setActiveTicketId(null)}>✕</button>
                    </div>
                  </div>
                  <div style={{ flexGrow: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <ChatPanel
                      ticketId={activeTicketId}
                      socket={socket}
                      currentUserId={user?.id}
                      currentUserRole="agent"
                      ticketStatus={tickets.find(t => t.id === activeTicketId)?.status}
                    />
                  </div>
                </div>
              ) : (
                <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '0.75rem' }}>
                  <div style={{ fontSize: '2.5rem', opacity: 0.4 }}>💬</div>
                  <div className="text-secondary text-sm">Select a conversation to view</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── ON-HOLD TAB ── */}
        {activeTab === 'on-hold' && (
          <div style={{ display: 'flex', gap: '1rem', flexGrow: 1, minHeight: 0 }}>
            {/* Sidebar */}
            <div style={{
              width: '280px', flexShrink: 0,
              background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)', overflowY: 'auto',
              display: 'flex', flexDirection: 'column', padding: '0.875rem',
            }}>
              <div className="chat-sidebar-section-label">On-Hold Tickets</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {myOnHoldTickets.length === 0
                  ? <p className="text-xs text-muted" style={{ padding: '0.5rem 0' }}>No tickets on hold</p>
                  : myOnHoldTickets.map(t => <ChatListItem key={t.id} t={t} isOnHold />)
                }
              </div>
            </div>

            {/* Chat area */}
            <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              {activeTicketId ? (
                <div className="card" style={{ padding: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', borderBottom: '1px solid var(--border-subtle)' }}>
                    <div>
                      <div className="font-semibold text-sm">⏸ On Hold — {tickets.find(t => t.id === activeTicketId)?.subject}</div>
                      <div className="text-xs text-muted">{tickets.find(t => t.id === activeTicketId)?.customer_name}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={async () => {
                          try { await ticketApi.close(activeTicketId); fetchTickets(); setActiveTicketId(null); }
                          catch { setToast({ subject: 'Failed to resolve', isError: true }); setTimeout(() => setToast(null), 4000); }
                        }}
                      >
                        ✓ Resolve
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setActiveTicketId(null)}>✕</button>
                    </div>
                  </div>
                  <div style={{ flexGrow: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <ChatPanel
                      ticketId={activeTicketId}
                      socket={socket}
                      currentUserId={user?.id}
                      currentUserRole="agent"
                      ticketStatus={tickets.find(t => t.id === activeTicketId)?.status}
                    />
                  </div>
                </div>
              ) : (
                <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '0.75rem' }}>
                  <div style={{ fontSize: '2.5rem', opacity: 0.4 }}>⏸️</div>
                  <div className="text-secondary text-sm">Select an on-hold ticket to view</div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
