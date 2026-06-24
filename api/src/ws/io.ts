import type { Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';
import { env } from '../env.js';
import { verifyToken, type AuthedAgent } from '../auth/jwt.js';

// Socket path matches the spec's `WS /console` and the Vite dev proxy.
const WS_PATH = '/console';

let io: IOServer | null = null;

interface SocketData {
  agent: AuthedAgent;
}

export function initIo(server: HttpServer): IOServer {
  io = new IOServer(server, {
    path: WS_PATH,
    cors: {
      origin: env.WEB_ORIGIN === '*' ? true : env.WEB_ORIGIN.split(','),
      credentials: true,
    },
  });

  // Authenticate every socket via JWT supplied in the handshake.
  io.use((socket: Socket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      (socket.handshake.headers.authorization?.replace('Bearer ', ''));
    const agent = token ? verifyToken(token) : null;
    if (!agent) return next(new Error('unauthorized'));
    (socket.data as SocketData).agent = agent;
    next();
  });

  return io;
}

// Push an event to every connected (authenticated) console.
export function pushToConsole(event: string, payload: unknown): void {
  io?.emit(event, payload);
}

export function getIo(): IOServer | null {
  return io;
}
