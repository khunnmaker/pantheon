import type { Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';
import { env } from '../env.js';
import { type AuthedAgent, hasAppAccess } from '../auth/jwt.js';
import { authedAgentFromToken } from '../auth/middleware.js';

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

  // Authenticate every socket via JWT supplied in the handshake, re-validated
  // against the live account (same path as the REST preHandler).
  io.use((socket: Socket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      socket.handshake.headers.authorization?.replace('Bearer ', '') ??
      null;
    authedAgentFromToken(token)
      .then((agent) => {
        if (!agent) return next(new Error('unauthorized'));
        // The console is Minerva-facing — a Ceres-only staff member (or a role without Minerva) must not
        // get a live socket into sales conversations.
        if (!hasAppAccess(agent, 'minerva')) return next(new Error('unauthorized'));
        (socket.data as SocketData).agent = agent;
        next();
      })
      .catch(() => next(new Error('unauthorized')));
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
