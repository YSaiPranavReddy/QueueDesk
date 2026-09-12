/**
 * ChatPanel — M6
 *
 * Shared real-time chat component used in both CustomerDashboard and AgentDashboard.
 *
 * Props:
 *   ticketId  — string, the active ticket
 *   socket    — Socket.IO socket instance from useSocket()
 *   currentUserId — string
 *   currentUserRole — 'customer' | 'agent' | 'admin'
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { ticketApi } from '../api/tickets.js';
import './ChatPanel.css';

export default function ChatPanel({ ticketId, socket, currentUserId, currentUserRole, ticketStatus }) {
  const [messages,   setMessages]   = useState([]);
  const [input,      setInput]      = useState('');
  const [sending,    setSending]    = useState(false);
  const [typingUser, setTypingUser] = useState(null); // { role }
  const [partnerStatus, setPartnerStatus] = useState('online'); // 'online' | 'offline'
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [chatError, setChatError] = useState('');
  const [closedLive, setClosedLive] = useState(false);
  const bottomRef  = useRef(null);
  const typingTimer = useRef(null);

  const isClosed = ticketStatus === 'closed' || closedLive;

  useEffect(() => {
    setClosedLive(false);
    setChatError('');
  }, [ticketId]);

  // ── Load persisted history via REST on mount ─────────────────────────────────
  useEffect(() => {
    if (!ticketId) return;
    ticketApi.messages(ticketId)
      .then(({ data }) => setMessages(data.messages || []))
      .catch(() => {})
      .finally(() => setLoadingHistory(false));
  }, [ticketId]);

  // ── Socket events ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket || !ticketId) return;

    // Ensure user joins the room when chat opens and requests latest history
    socket.emit('chat:join', { ticketId });
    socket.emit('chat:status:request', { ticketId });

    // Incoming message
    const onMessage = ({ message }) => {
      if (message.ticket_id !== ticketId) return; // Prevent cross-chat pollution

      setMessages((prev) => {
        // Avoid duplicates (message may already be in list from REST history)
        if (prev.some((m) => m.id === message.id)) return prev;
        
        // Remove optimistic message that matches this one
        const filtered = prev.filter(m => !(m.id.startsWith('temp-') && m.sender_id === message.sender_id && m.body === message.body));
        
        return [...filtered, message];
      });
    };

    // History (on reconnect or chat:join)
    const onHistory = ({ ticketId: tId, messages: hist }) => {
      if (tId !== ticketId) return;
      setMessages(hist || []);
      setLoadingHistory(false);
    };

    // Typing indicator
    const onTyping = ({ ticketId: tId, role, isTyping }) => {
      if (tId !== ticketId) return;
      setTypingUser(isTyping ? { role } : null);
      if (isTyping) {
        clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => setTypingUser(null), 3000);
      }
    };

    socket.on('chat:message', onMessage);
    socket.on('chat:history', onHistory);
    socket.on('chat:typing',  onTyping);
    socket.on('ticket:closed', () => setClosedLive(true));
    socket.on('chat:error', ({ message }) => {
      setChatError(message);
      setTimeout(() => setChatError(''), 5000);
    });
    socket.on('customer:offline', () => setPartnerStatus('offline'));
    socket.on('customer:online',  () => setPartnerStatus('online'));
    socket.on('agent:offline',    () => setPartnerStatus('offline'));
    socket.on('agent:online',     () => setPartnerStatus('online'));

    return () => {
      socket.off('chat:message', onMessage);
      socket.off('chat:history', onHistory);
      socket.off('chat:typing',  onTyping);
      socket.off('ticket:closed');
      socket.off('chat:error');
      socket.off('customer:offline');
      socket.off('customer:online');
      socket.off('agent:offline');
      socket.off('agent:online');
      clearTimeout(typingTimer.current);
    };
  }, [socket, ticketId, currentUserRole]);

  // ── Auto-scroll to bottom on new message ─────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Send message ─────────────────────────────────────────────────────────────
  const handleSend = useCallback(async (e) => {
    e?.preventDefault();
    const body = input.trim();
    if (!body || sending || !socket) return;

    setSending(true);

    // Optimistic UI update so the message appears instantly
    const optimisticMsg = {
      id: `temp-${Date.now()}`,
      ticket_id: ticketId,
      sender_id: currentUserId,
      body,
      created_at: new Date().toISOString()
    };
    setMessages(prev => [...prev, optimisticMsg]);

    socket.emit('chat:send', { ticketId, body });
    setInput('');
    setSending(false);
  }, [input, sending, socket, ticketId, currentUserId]);

  // ── Typing indicator ─────────────────────────────────────────────────────────
  const handleTyping = (e) => {
    setInput(e.target.value);
    if (!socket) return;
    socket.emit('chat:typing', { ticketId, isTyping: true });
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      socket.emit('chat:typing', { ticketId, isTyping: false });
    }, 1500);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-header">
        <div className={`chat-header-dot ${isClosed ? 'closed' : partnerStatus === 'offline' ? 'offline' : 'online'}`} />
        <span className="chat-header-title">
          {isClosed ? 'Archived Chat' : 'Live Support Chat'}
        </span>
        <span className="chat-header-status">
          {isClosed ? 'Closed' : partnerStatus === 'offline' ? '⚠ Offline' : '● Online'}
        </span>
        <span className="text-muted text-xs">#{ticketId?.slice(0, 8)}</span>
      </div>

      {/* Message list */}
      <div className="chat-messages">
        {loadingHistory ? (
          <div className="chat-loading">
            <div className="spinner" style={{ width: 20, height: 20 }} />
          </div>
        ) : messages.length === 0 ? (
          <div className="chat-empty">
            <span>👋</span>
            <p>Say hello to start the conversation</p>
          </div>
        ) : (
          messages.map((m) => {
            const isMe = m.sender_id === currentUserId;
            const isSystem = m.sender_role === 'system';
            if (isSystem) {
              return (
                <div key={m.id} className="chat-msg chat-msg-system">
                  <div className="chat-bubble">
                    <span className="chat-bubble-body">{m.body}</span>
                  </div>
                </div>
              );
            }
            return (
              <div key={m.id} className={`chat-msg ${isMe ? 'chat-msg-mine' : 'chat-msg-theirs'}`}>
                {!isMe && (
                  <div className="chat-msg-role">
                    {m.sender_role === 'agent' ? '🎧 Agent' : '👤 Customer'}
                  </div>
                )}
                <div className="chat-bubble">
                  <span className="chat-bubble-body">{m.body}</span>
                  <span className="chat-bubble-time">{formatTime(m.created_at || m.sent_at)}</span>
                </div>
              </div>
            );
          })
        )}

        {/* Typing indicator */}
        {typingUser && (
          <div className="chat-typing">
            <span className="typing-dots"><span /><span /><span /></span>
            <span className="text-xs text-muted">{typingUser.role === 'agent' ? 'Agent' : 'Customer'} is typing</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {chatError && (
        <div className="text-error text-xs" style={{ padding: '0 1rem', textAlign: 'center' }}>
          {chatError}
        </div>
      )}
      <form className="chat-input-row" onSubmit={handleSend}>
        <textarea
          id={`chat-input-${ticketId}`}
          className="chat-input"
          placeholder={isClosed ? 'This conversation is closed' : 'Type a message… (Enter to send)'}
          rows={2}
          value={input}
          onChange={handleTyping}
          onKeyDown={handleKeyDown}
          disabled={sending || isClosed}
        />
        <button
          id={`chat-send-${ticketId}`}
          type="submit"
          className="chat-send-btn"
          disabled={!input.trim() || sending || isClosed}
        >
          ➤
        </button>
      </form>
    </div>
  );
}
