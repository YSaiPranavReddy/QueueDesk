import api from './axios.js';

export const ticketApi = {
  create:   (data)       => api.post('/api/tickets', data),
  list:     (params)     => api.get('/api/tickets', { params }),
  get:      (id)         => api.get(`/api/tickets/${id}`),
  close:    (id)         => api.patch(`/api/tickets/${id}/close`),
  putOnHold: (id)        => api.patch(`/api/tickets/${id}/hold`),
  claim:    (id)         => api.post(`/api/tickets/${id}/claim`),
  messages: (id, params) => api.get(`/api/tickets/${id}/messages`, { params }),
  setPriority: (id, priority) => api.patch(`/api/tickets/${id}/priority`, { priority }),
};


export const agentApi = {
  setStatus: (status) => api.patch('/api/agents/status', { status }),
  list:      ()       => api.get('/api/agents'),
};
