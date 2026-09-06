import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

export const options = {
  stages: [
    { duration: '10s', target: 20 }, // ramp up to 20 users
    { duration: '20s', target: 20 }, // hold
    { duration: '10s', target: 0 },  // ramp down
  ],
};

const queuePositionLatency = new Trend('queue_position_latency');
const successfulMatches = new Counter('successful_matches');

export default function () {
  const timestamp = new Date().getTime();
  const vu = __VU;
  const iter = __ITER;
  const email = `customer_${timestamp}_${vu}_${iter}@example.com`;
  const password = 'password123';
  const name = `Test Customer ${vu}`;

  // 1. Register
  const regRes = http.post('http://localhost:8080/api/auth/register', JSON.stringify({
    name, email, password, role: 'customer'
  }), {
    headers: { 'Content-Type': 'application/json' }
  });

  check(regRes, { 'registered': (r) => r.status === 201 });
  if (regRes.status !== 201) {
    console.log("Registration failed", regRes.body);
    return;
  }
  const token = regRes.json('accessToken');

  // 2. Connect WebSocket
  // Socket.IO v4 URL format
  const url = `ws://localhost:8080/socket.io/?EIO=4&transport=websocket&token=${token}`;
  
  let ticketId = null;
  let queueJoinTime = 0;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      // Create ticket after connecting
      const ticketRes = http.post('http://localhost:8080/api/tickets', JSON.stringify({
        subject: `Help me ${timestamp}`
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}` 
        }
      });
      
      check(ticketRes, { 'ticket created': (r) => r.status === 201 });
      if (ticketRes.status === 201) {
        ticketId = ticketRes.json('ticket.id');
        queueJoinTime = new Date().getTime();
      }
    });

    socket.on('message', function (msg) {
      // Socket.IO protocol messages
      if (msg === '2') {
        socket.send('3'); // ping/pong
        return;
      }
      
      if (msg.startsWith('42')) {
        const payload = JSON.parse(msg.substring(2));
        const event = payload[0];
        const data = payload[1];
        
        if (event === 'queue:position') {
          // Track latency if we want, or just record it happened
        } else if (event === 'ticket:matched') {
          successfulMatches.add(1);
          // Matched! Close socket after a short delay
          socket.setTimeout(function () {
            socket.close();
          }, 500);
        }
      }
    });

    socket.on('close', function () {
      // Closed
    });
    
    // Timeout if we wait too long
    socket.setTimeout(function () {
      socket.close();
    }, 45000); // 45 seconds max wait
  });
  
  check(res, { 'status is 101': (r) => r && r.status === 101 });
  sleep(1);
}
