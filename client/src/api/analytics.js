import api from './axios.js';

export const analyticsApi = {
  getMetrics: () => api.get('/analytics'),
};
