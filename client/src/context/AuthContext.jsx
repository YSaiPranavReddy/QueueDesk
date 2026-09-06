/**
 * AuthContext — global auth state.
 *
 * Provides:
 *   user          — current user object or null
 *   isLoading     — true while initial session restore is in flight
 *   login()       — call after successful login, stores token + user
 *   logout()      — clears token, calls API logout
 *   setUser()     — update user fields (e.g. after profile change)
 */
import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/auth.js';
import { setAccessToken, clearAccessToken } from '../api/axios.js';

const AuthContext = createContext(null);

const ROLE_HOME = {
  customer: '/customer',
  agent:    '/agent',
  admin:    '/admin',
};

export function AuthProvider({ children }) {
  const [user, setUser]         = useState(null);
  const [isLoading, setLoading] = useState(true); // restore session on mount
  const navigate = useNavigate();
  const logoutInFlight = useRef(false);

  // ── Restore session on app load ─────────────────────────────────────────────
  useEffect(() => {
    const restore = async () => {
      try {
        const { data } = await authApi.refresh();       // uses httpOnly cookie
        setAccessToken(data.accessToken);
        const meRes = await authApi.me();
        setUser(meRes.data.user);
      } catch {
        // No valid session — stay on login page
        clearAccessToken();
      } finally {
        setLoading(false);
      }
    };
    restore();
  }, []);

  // ── Listen for global auth:logout event (from axios interceptor) ────────────
  useEffect(() => {
    const handleForceLogout = () => {
      if (logoutInFlight.current) return;
      setUser(null);
      clearAccessToken();
      navigate('/login', { replace: true });
    };
    window.addEventListener('auth:logout', handleForceLogout);
    return () => window.removeEventListener('auth:logout', handleForceLogout);
  }, [navigate]);

  // ── login: called after successful login/register API response ──────────────
  const login = useCallback((accessToken, userData) => {
    setAccessToken(accessToken);
    setUser(userData);
    navigate(ROLE_HOME[userData.role] ?? '/', { replace: true });
  }, [navigate]);

  // ── logout ──────────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    if (logoutInFlight.current) return;
    logoutInFlight.current = true;
    try {
      await authApi.logout();
    } catch {
      // swallow — clear state regardless
    } finally {
      clearAccessToken();
      setUser(null);
      logoutInFlight.current = false;
      navigate('/login', { replace: true });
    }
  }, [navigate]);

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
