/**
 * Axios instance — base config + request/response interceptors.
 *
 * Access token:   stored in memory (AuthContext), attached per-request via interceptor.
 * Refresh token:  httpOnly cookie — browser sends it automatically on /api/auth/refresh.
 * Silent refresh: on 401, retry the original request once after refreshing the token.
 */
import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3001',
  withCredentials: true, // Always send cookies (refresh token)
  timeout: 10000,
});

// ── In-memory access token store ─────────────────────────────────────────────
// NOT localStorage — visible to JS only within this module.
let _accessToken = null;

export const setAccessToken   = (token) => { _accessToken = token; };
export const clearAccessToken = ()      => { _accessToken = null;  };
export const getAccessToken   = ()      => _accessToken;

// ── Request interceptor: attach Bearer token ──────────────────────────────────

api.interceptors.request.use(
  (config) => {
    if (_accessToken) {
      config.headers.Authorization = `Bearer ${_accessToken}`;
    }
    return config;
  },
  (err) => Promise.reject(err)
);

// ── Response interceptor: silent refresh on 401 ───────────────────────────────
let _isRefreshing = false;
let _waitQueue = []; // queued requests waiting for refresh to complete

const processQueue = (error, token = null) => {
  _waitQueue.forEach((p) => (error ? p.reject(error) : p.resolve(token)));
  _waitQueue = [];
};

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config;

    // Only attempt refresh on 401 and only once per request
    if (
      err.response?.status === 401 &&
      !original._retried &&
      !original.url?.includes('/api/auth/refresh') &&
      !original.url?.includes('/api/auth/login')
    ) {
      if (_isRefreshing) {
        // Queue this request while refresh is in flight
        return new Promise((resolve, reject) => {
          _waitQueue.push({ resolve, reject });
        })
          .then((token) => {
            original.headers.Authorization = `Bearer ${token}`;
            return api(original);
          })
          .catch((e) => Promise.reject(e));
      }

      original._retried = true;
      _isRefreshing = true;

      try {
        const { data } = await axios.post(
          `${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/auth/refresh`,
          {},
          { withCredentials: true }
        );
        const newToken = data.accessToken;
        setAccessToken(newToken);
        processQueue(null, newToken);
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      } catch (refreshErr) {
        processQueue(refreshErr, null);
        clearAccessToken();
        // Dispatch a global event so AuthContext can redirect to login
        window.dispatchEvent(new Event('auth:logout'));
        return Promise.reject(refreshErr);
      } finally {
        _isRefreshing = false;
      }
    }

    return Promise.reject(err);
  }
);

export default api;
