/**
 * useSocket — custom hook for Socket.IO client (M4)
 *
 * Connects once with the user's access token, reconnects automatically,
 * and exposes the socket instance + a connection state flag.
 *
 * Usage:
 *   const { socket, connected } = useSocket();
 */
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../context/AuthContext.jsx';
import { getAccessToken } from '../api/axios.js';

const SOCKET_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export const useSocket = () => {
  const { user } = useAuth();             // re-connect when user changes (login/logout)
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Initial token check to prevent needless connection attempts
    const initialToken = getAccessToken();
    if (!user || !initialToken) return;

    const socket = io(SOCKET_URL, {
      auth: (cb) => cb({ token: getAccessToken() }), // re-reads fresh token on every reconnect attempt
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity, // never give up connecting silently
    });

    socketRef.current = socket;

    let pingInterval = null;

    socket.on('connect', () => {
      setConnected(true);
      if (user?.role === 'agent') {
        // Emit immediately on connect, then every 30s
        socket.emit('ping:agent');
        pingInterval = setInterval(() => {
          socket.emit('ping:agent');
        }, 30000);
      }
    });

    socket.on('disconnect', () => {
      setConnected(false);
      if (pingInterval) clearInterval(pingInterval);
    });

    return () => {
      if (pingInterval) clearInterval(pingInterval);
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [user]);

  return { socket: socketRef.current, connected };
};
