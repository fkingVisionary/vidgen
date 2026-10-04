import { pino, type Logger } from 'pino';
import type { Env } from './env.ts';

/** Structured JSON logs (Railway-friendly); pretty-printed in local development. */
export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>, name = 'api'): Logger {
  const pretty = env.NODE_ENV === 'development' && process.stdout.isTTY;
  return pino({
    name,
    level: env.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', 'headers.authorization', '*.password', '*.apiKey', '*.secret', '*.token'],
      censor: '[REDACTED]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
  });
}
