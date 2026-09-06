/**
 * AgentDashboard — M2.T5
 * Real: ticket list from API + status toggle.
 * Claiming (M5) and chat (M6) added next.
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

  const [tickets,     setTickets]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [agentStatus, setAgentStatus] = useState(() => localStorage.getItem('agentStatus') || 'offline');
  const [statusLoading, setStatusLoading] = useState(false);
  const [filter,      setFilter]      = useState('');
  const [toast,       setToast]       = useState(null); // { subject, ticketId }
  const [claimingId,  setClaimingId]  = useState(null); // ticketId currently being claimed
  const [activeTab, setActiveTab] = useState('queue'); // 'queue' | 'chats'
  const [activeTicketId, setActiveTicketId] = useState(null); // which chat is open
  const [unreadCounts, setUnreadCounts] = useState({});       // { ticketId: count }
  const [notifications, setNotifications] = useState([]);     // [ { id, message, ... } ]
  const [showNotifPanel, setShowNotifPanel] = useState(false);

  const { socket } = useSocket();

  // Active chats = tickets assigned to me (excluding on-hold/open)
  const myActiveTickets = tickets.filter(
    (t) => t.agent_id === user?.id && t.status === 'assigned'
  );
  // On-Hold chats = tickets assigned to me, status open
  const myOnHoldTickets = tickets.filter(
    (t) => t.agent_id === user?.id && t.status === 'open'
  );
  const myCompletedTickets = tickets.filter(
    (t) => t.agent_id === user?.id && t.status === 'closed'
  );

  const fetchTickets = useCallback(async () => {
    try {
      const params = filter ? { status: filter } : {};
      const { data } = await ticketApi.list(params);
      setTickets(data.tickets);
    } catch {
      // silent — spinner stays hidden on error
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchTickets();
    const interval = setInterval(fetchTickets, 30000);
    return () => clearInterval(interval);
  }, [fetchTickets]);

  // Socket: new ticket assigned to this agent
  useEffect(() => {
    if (!socket) return;
    
    // Auto-resync status on reconnect to clear the backend's 'offline' grace flag
    const handleConnect = async () => {
      if (agentStatus !== 'offline') {
        try { await agentApi.setStatus(agentStatus); } catch (_) {}
      }
    };
    socket.on('connect', handleConnect);

    socket.on('ticket:assigned', ({ ticket }) => {
      setToast({ subject: ticket.subject, ticketId: ticket.id });
      fetchTickets(); // refresh queue
      socket.emit('chat:join', { ticketId: ticket.id }); // Auto-join room for background notifications
      setTimeout(() => setToast(null), 6000); // auto-dismiss
    });

    // NEW — a ticket just went pending (queued), show it live without a refresh
    socket.on('ticket:pending', ({ ticket }) => {
      setTickets((prev) => (prev.some((t) => t.id === ticket.id) ? prev : [ticket, ...prev]));
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

    socket.on('ticket:on_hold', () => {
      fetchTickets();
    });

    socket.on('agent:notification', (notif) => {
      setNotifications((prev) => [notif, ...prev]);
    });

    return () => {
      socket.off('connect', handleConnect);
      socket.off('ticket:assigned');
      socket.off('ticket:pending');
      socket.off('chat:message');
      socket.off('ticket:closed');
      socket.off('ticket:on_hold');
      socket.off('agent:notification');
    };
  }, [socket, fetchTickets, activeTicketId, activeTab, agentStatus]);


  const openChat = (ticketId) => {
    setActiveTicketId(ticketId);
    setUnreadCounts((prev) => ({ ...prev, [ticketId]: 0 })); // clear badge on open
  };

  const handleStatusChange = async (newStatus) => {
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

  const handleClaim = async (ticketId) => {
    setClaimingId(ticketId);
    try {
      await ticketApi.claim(ticketId);
      openChat(ticketId); // open chat after claiming and clear badge
      setActiveTab('chats'); // navigate to chats tab
      await fetchTickets();
    } catch (err) {
      const msg = err.response?.data?.message || 'Could not claim ticket';
      setToast({ subject: msg, ticketId: null, isError: true });
      setTimeout(() => setToast(null), 4000);
    } finally {
      setClaimingId(null);
    }
  };

  const pending  = tickets.filter((t) => t.status === 'pending').length;
  const myActive = tickets.filter((t) => t.agent_id === user?.id && t.status !== 'closed').length;
  const closed   = tickets.filter((t) => t.status === 'closed').length;

  return (
    <div className="dash-layout">
      <aside className="dash-sidebar">
        <div className="dash-logo">
          <img src="/logo.png" alt="QueueDesk logo" className="landing-logo-image" />
          <span className="landing-brand-name">Queue<span className="landing-brand-name-accent">Desk</span></span>
        </div>

        {/* Agent status toggle */}
        <div className="agent-status-panel card">
          <p className="text-xs text-muted" style={{ marginBottom: '.5rem' }}>MY STATUS</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.35rem' }}>
            {['available', 'busy', 'offline'].map((s) => (
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

        <nav className="dash-nav">
          <button 
            className={`dash-nav-item ${activeTab === 'queue' ? 'active' : ''}`} 
            onClick={() => { setActiveTab('queue'); setActiveTicketId(null); }}
            style={{ width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
          >
            <span>📥</span> Ticket Queue
          </button>
          <button 
            className={`dash-nav-item ${activeTab === 'chats' ? 'active' : ''}`} 
            onClick={() => { setActiveTab('chats'); setActiveTicketId(null); }}
            style={{ width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}
          >
            <span>💬</span> My Chats
          </button>
          <button 
            className={`dash-nav-item ${activeTab === 'on-hold' ? 'active' : ''}`} 
            onClick={() => { setActiveTab('on-hold'); setActiveTicketId(null); }}
            style={{ width: '100%', textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}
          >
            <span>⏸️</span> On-Hold
          </button>
        </nav>

        <div style={{ padding: '0 1rem', marginTop: 'auto', marginBottom: '1rem', position: 'relative' }}>
          <button 
            onClick={() => setShowNotifPanel(!showNotifPanel)}
            className="btn btn-ghost"
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <span>🔔 Notifications</span>
            {notifications.length > 0 && (
              <span className="badge badge-red">{notifications.length}</span>
            )}
          </button>
          
          {showNotifPanel && (
            <div className="card shadow" style={{ position: 'absolute', bottom: '100%', left: '1rem', right: '1rem', zIndex: 10, padding: '0.5rem', maxHeight: '300px', overflowY: 'auto', marginBottom: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <h4 style={{ margin: 0, fontSize: '0.9rem' }}>Reminders</h4>
                <button className="btn btn-ghost btn-sm" onClick={() => setNotifications([])} style={{ fontSize: '0.7rem', padding: '0.2rem' }}>Clear</button>
              </div>
              {notifications.length === 0 ? <p className="text-sm text-muted">No new notifications</p> : null}
              {notifications.map(n => (
                <div key={n.id} style={{ padding: '0.5rem', borderBottom: '1px solid var(--border)', fontSize: '0.85rem', cursor: 'pointer' }} onClick={() => { setActiveTab('on-hold'); openChat(n.ticketId); setShowNotifPanel(false); }}>
                  <div style={{ fontWeight: 600 }}>{n.subject}</div>
                  <div className="text-muted text-xs">{n.message}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="dash-user">
          <div className="dash-user-avatar agent-avatar">{user?.name?.[0]?.toUpperCase()}</div>
          <div className="dash-user-info">
            <span className="dash-user-name">{user?.name}</span>
            <span className="dash-user-role badge badge-blue">Agent</span>
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
        {/* Toast: new ticket assigned */}
        {toast && (
          <div className="queue-banner queue-banner-matched animate-fadeUp" style={{ flexShrink: 0 }}>
            <span className="queue-banner-icon">🎫</span>
            <div>
              <div className="font-semibold">New ticket assigned!</div>
              <div className="text-sm">{toast.subject}</div>
            </div>
            <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setToast(null)}>✕</button>
          </div>
        )}

        {activeTab === 'queue' ? (
          <div style={{ overflowY: 'auto', flexGrow: 1 }}>


        {/* Stats */}
        <div className="dash-stats-row">
          {[
            { label: 'In Queue',      value: pending,  icon: '⏳' },
            { label: 'My Active',     value: myActive, icon: '🎫' },
            { label: 'Closed Today',  value: closed,   icon: '✅' },
          ].map(({ label, value, icon }) => (
            <div key={label} className="dash-stat-card card">
              <div className="dash-stat-icon">{icon}</div>
              <div className="dash-stat-value">{value}</div>
              <div className="dash-stat-label text-secondary text-sm">{label}</div>
            </div>
          ))}
        </div>

        {/* Filter tabs */}
        <div className="dash-filter-tabs">
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
          <div className="dash-coming-soon card">
            <div className="coming-soon-icon">📭</div>
            <h3 className="font-semibold">No tickets {filter ? `with status "${filter}"` : 'yet'}</h3>
          </div>
        ) : (
          <div className="ticket-list">
            {tickets.map((t) => (
              <div key={t.id} className="ticket-row card animate-fadeUp">
                <div className="ticket-row-left">
                  <span className={`badge ${STATUS_BADGE[t.status] || 'badge-blue'}`}>{t.status}</span>
                  <div>
                    <div className="ticket-subject">{t.subject}</div>
                    <div className="text-muted text-xs">by {t.customer_name}</div>
                  </div>
                </div>
                <div className="ticket-row-right">
                  <span className={`badge badge-${t.priority === 'urgent' ? 'red' : t.priority === 'high' ? 'yellow' : 'blue'}`}>
                    {t.priority}
                  </span>
                  {/* Claim button wired in M5 */}
                  {t.status === 'pending' && (
                    <button
                      id={`claim-${t.id}`}
                      className="btn btn-primary btn-sm"
                      disabled={claimingId === t.id}
                      onClick={() => handleClaim(t.id)}
                    >
                      {claimingId === t.id ? <><div className="spinner" style={{width:12,height:12}}/> Claiming…</> : 'Claim →'}
                    </button>
                  )}
                  <span className="text-muted text-xs">{new Date(t.created_at).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        </div>
        ) : activeTab === 'on-hold' ? (
          <div className="chats-view" style={{ display: 'flex', gap: '1.5rem', flexGrow: 1, minHeight: 0 }}>
            {/* Chat Sidebar (On-Hold) */}
            <div className="chat-sidebar card" style={{ width: '320px', flexShrink: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
              <h4 className="font-semibold text-sm" style={{ marginBottom: '.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>On-Hold Tickets</h4>
              {myOnHoldTickets.length === 0 ? (
                <p className="text-muted text-xs">No tickets currently on hold</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {myOnHoldTickets.map((t) => (
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
                      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        <span className="text-sm truncate" style={{ color: 'inherit' }}>{t.customer_name} : {t.subject}</span>
                        <span className="text-xs truncate opacity-70">Updated: {new Date(t.updated_at).toLocaleString()}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            
            {/* Chat Panel placeholder for On-Hold (so they can see history) */}
            <div className="chat-content" style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              {activeTicketId ? (
                <div className="card" style={{ padding: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', borderBottom: '1px solid var(--border-subtle)' }}>
                    <span className="font-semibold text-sm">
                      On-Hold — {tickets.find(t => t.id === activeTicketId)?.subject}
                    </span>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button 
                        className="btn btn-sm btn-primary" 
                        onClick={async () => {
                          try {
                            await ticketApi.close(activeTicketId);
                            fetchTickets();
                            setActiveTicketId(null);
                          } catch (err) {
                            setToast({ subject: 'Failed to resolve', isError: true });
                            setTimeout(() => setToast(null), 4000);
                          }
                        }}
                      >
                        ✓ Resolve
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setActiveTicketId(null)}>✕ Close view</button>
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
                <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>⏸️</div>
                    <div>Select a ticket from the sidebar to view history</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="chats-view" style={{ display: 'flex', gap: '1.5rem', flexGrow: 1, minHeight: 0 }}>
            {/* Chat Sidebar (Active & Completed) */}
            <div className="chat-sidebar card" style={{ width: '320px', flexShrink: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
              <h4 className="font-semibold text-sm" style={{ marginBottom: '.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Assigned Chats</h4>
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
                        <span className="text-sm truncate" style={{ color: 'inherit' }}>{t.customer_name} : {t.subject}</span>
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
                      <span className="text-sm truncate" style={{ color: 'inherit' }}>{t.customer_name} : {t.subject}</span>
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
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      {tickets.find(t => t.id === activeTicketId)?.status === 'assigned' && (
                        <button 
                          className="btn btn-sm" 
                          style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
                          onClick={async () => {
                            try {
                              await ticketApi.putOnHold(activeTicketId);
                              fetchTickets();
                              setActiveTab('on-hold');
                            } catch (err) {
                              setToast({ subject: 'Failed to put on hold', isError: true });
                              setTimeout(() => setToast(null), 4000);
                            }
                          }}
                        >
                          ⏸️ Hold
                        </button>
                      )}
                      {tickets.find(t => t.id === activeTicketId)?.status !== 'closed' && (
                        <button 
                          className="btn btn-sm btn-primary" 
                          onClick={async () => {
                            try {
                              await ticketApi.close(activeTicketId);
                              fetchTickets(); // Will move it to Completed Tasks automatically!
                            } catch (err) {
                              setToast({ subject: 'Failed to close ticket', isError: true });
                              setTimeout(() => setToast(null), 4000);
                            }
                          }}
                        >
                          Resolve Ticket
                        </button>
                      )}
                      <button className="btn btn-ghost btn-sm" onClick={() => setActiveTicketId(null)}>✕ Close chat</button>
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
