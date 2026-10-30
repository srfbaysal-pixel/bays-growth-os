import type pg from 'pg';
import type { Config } from '../config.js';
import type { AiProvider } from '../ai/types.js';
import type { EmailProvider } from '../email/types.js';
import type { DiscoveryProvider } from '../discovery/types.js';
import type { User } from '../auth/service.js';

export interface AppContext {
  cfg: Config;
  pool: pg.Pool;
  ai: AiProvider;
  email: EmailProvider;
  discovery: DiscoveryProvider;
  fetchFn?: typeof fetch;
  lookup?: (hostname: string) => Promise<string[]>;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    sessionToken?: string;
    rawBodyText?: string;
  }
}
