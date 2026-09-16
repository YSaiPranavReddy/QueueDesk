import api from './index.js';

export const analyticsApi = {
  getMetrics: () => api.get('/analytics'),
};
