import { io, type Socket } from 'socket.io-client';
import { API_URL, getToken } from './api';

// Single shared Socket.IO connection to the console channel, authed by JWT.
let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_URL, {
      path: '/console',
      // Read the token lazily on every (re)connect so reconnections always use
      // the current token rather than one frozen at first connect.
      auth: (cb) => cb({ token: getToken() ?? '' }),
      transports: ['websocket', 'polling'],
    });
  }
  return socket;
}

export function disconnectSocket(): void {
  socket?.close();
  socket = null;
}
