import api from './axios.js';

export const authApi = {
  register: (data) => api.post('/api/auth/register', data),
  login:    (data) => api.post('/api/auth/login', data),
  refresh:  ()     => api.post('/api/auth/refresh'),
  logout:   ()     => api.post('/api/auth/logout'),
  me:       ()     => api.get('/api/auth/me'),
  updatePreferences: (data) => api.patch('/api/auth/me/preferences', data),
};
