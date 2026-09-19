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
import ReactMarkdown from 'react-markdown';
import './ChatPanel.css';

const CANNED_RESPONSES = [
  { command: '/hello', text: 'Hi there! How can I help you today?' },
  { command: '/hold', text: 'I need a few minutes to check with my team. Please hold on!' },
  { command: '/resolved', text: 'I believe this issue is resolved. Let me know if you need anything else!' },
  { command: '/docs', text: 'You can find more information in our documentation here: https://queuedesk.example.com/docs' },
  { command: '/escalate', text: 'I am going to escalate this to a specialist who can help you further.' }
];

export default function ChatPanel({ ticketId, socket, currentUserId, currentUserRole, ticketStatus }) {
  const [messages,   setMessages]   = useState([]);
  const [input,      setInput]      = useState('');
  const [sending,    setSending]    = useState(false);
  const [typingUser, setTypingUser] = useState(null); // { role }
  // For closed tickets, default to 'offline' — no one is in the room
  const [partnerStatus, setPartnerStatus] = useState(() => ticketStatus === 'closed' ? 'offline' : 'online');
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [chatError, setChatError] = useState('');
  const [closedLive, setClosedLive] = useState(false);
  const bottomRef  = useRef(null);
  const typingTimer = useRef(null);

  // Canned Responses State
  const [showCannedMenu, setShowCannedMenu] = useState(false);
  const [cannedFilter, setCannedFilter]     = useState('');
  const [selectedIndex, setSelectedIndex]   = useState(0);

  const filteredCanned = CANNED_RESPONSES.filter(c => 
    c.command.toLowerCase().startsWith(cannedFilter.toLowerCase())
  );

  const isClosed = ticketStatus === 'closed' || closedLive;

  useEffect(() => {
    // Reset all per-ticket state when switching tickets
    setClosedLive(false);
    setChatError('');
    setMessages([]);
    setLoadingHistory(true);
    setTypingUser(null);
    // Reset partner status: closed tickets have no live presence
    setPartnerStatus(ticketStatus === 'closed' ? 'offline' : 'online');
  }, [ticketId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync partnerStatus when ticketStatus prop changes (e.g. agent resolves while viewing)
  useEffect(() => {
    if (ticketStatus === 'closed') {
      setPartnerStatus('offline');
    }
  }, [ticketStatus]);

  // ── Load persisted history via REST on mount ─────────────────────────────────
  useEffect(() => {
    if (!ticketId) return;
    ticketApi.messages(ticketId)
      .then(({ data }) => setMessages(data.messages || []))
      .catch((err) => {
        console.error('[ChatPanel] Failed to load message history:', err?.response?.status, err?.message);
        setChatError('Failed to load chat history. Please try refreshing.');
      })
      .finally(() => setLoadingHistory(false));
  }, [ticketId]);

  // ── Socket events ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket || !ticketId) return;

    // Only join the live socket room for active (non-closed) tickets.
    // For closed/archived tickets, the REST fetch (above) is the single source of truth.
    // Emitting chat:join for closed tickets causes the server to send a chat:history
    // response that can race with and overwrite the REST-fetched messages.
    if (ticketStatus !== 'closed') {
      socket.emit('chat:join', { ticketId });
      socket.emit('chat:status:request', { ticketId });
    }

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

    // History (on reconnect or chat:join) — MERGE with existing instead of replace.
    // This prevents a race where socket history arrives after the REST fetch and wipes it.
    const onHistory = ({ ticketId: tId, messages: hist }) => {
      if (tId !== ticketId) return;
      if (!hist || hist.length === 0) {
        setLoadingHistory(false);
        return;
      }
      setMessages(prev => {
        // Merge: keep all existing messages and add any from socket not yet in state
        const existingIds = new Set(prev.map(m => m.id));
        const newOnes = hist.filter(m => !existingIds.has(m.id));
        const merged = [...prev, ...newOnes];
        // Sort by created_at to ensure correct order
        merged.sort((a, b) => new Date(a.created_at || a.sent_at) - new Date(b.created_at || b.sent_at));
        return merged;
      });
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

  // ── Typing indicator & Canned Responses ──────────────────────────────────────
  const handleTyping = (e) => {
    const val = e.target.value;
    setInput(val);

    // Canned responses trigger for agents
    if (currentUserRole === 'agent' && val.startsWith('/')) {
      setShowCannedMenu(true);
      setCannedFilter(val);
      setSelectedIndex(0);
    } else {
      setShowCannedMenu(false);
    }

    if (!socket) return;
    socket.emit('chat:typing', { ticketId, isTyping: true });
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      socket.emit('chat:typing', { ticketId, isTyping: false });
    }, 1500);
  };

  const handleSelectCanned = (text) => {
    setInput(text);
    setShowCannedMenu(false);
    document.getElementById(`chat-input-${ticketId}`)?.focus();
  };

  const handleKeyDown = (e) => {
    if (showCannedMenu && filteredCanned.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % filteredCanned.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + filteredCanned.length) % filteredCanned.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        handleSelectCanned(filteredCanned[selectedIndex].text);
        return;
      }
      if (e.key === 'Escape') {
        setShowCannedMenu(false);
        return;
      }
    }

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
          {isClosed ? '📁 Archived' : partnerStatus === 'offline' ? '⚠ Offline' : '● Online'}
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
                    <ReactMarkdown className="markdown-body">{m.body}</ReactMarkdown>
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
                  <ReactMarkdown className="markdown-body">{m.body}</ReactMarkdown>
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
      
      {/* Input container with relative positioning for the absolute popup */}
      <div style={{ position: 'relative' }}>
        {/* Canned Responses Menu */}
        {showCannedMenu && filteredCanned.length > 0 && (
          <div className="canned-menu">
            {filteredCanned.map((item, idx) => (
              <button
                key={item.command}
                type="button"
                className={`canned-item ${idx === selectedIndex ? 'active' : ''}`}
                onClick={() => handleSelectCanned(item.text)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <span className="canned-item-cmd">{item.command}</span>
                <span className="canned-item-text">{item.text}</span>
              </button>
            ))}
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
    </div>
  );
}
