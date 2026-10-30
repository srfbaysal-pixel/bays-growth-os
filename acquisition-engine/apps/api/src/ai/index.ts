import type { Config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { dayBucket } from '../lib/normalize.js';
import { AnthropicAiProvider } from './anthropic.js';
import { MockAiProvider } from './mock.js';
import type { AiProvider } from './types.js';

export function makeAiProvider(cfg: Config, db: Queryable, fetchFn?: typeof fetch): AiProvider {
  if (cfg.AI_PROVIDER === 'anthropic') {
    if (!cfg.ANTHROPIC_API_KEY) throw new Error('AI_PROVIDER=anthropic için ANTHROPIC_API_KEY gerekli');
    return new AnthropicAiProvider({
      apiKey: cfg.ANTHROPIC_API_KEY,
      model: cfg.ANTHROPIC_MODEL,
      fetchFn,
      dailyLimit: cfg.AI_DAILY_CALL_LIMIT,
      counter: async () => {
        const r = await db.query(
          `INSERT INTO email_quota_usage(bucket, provider, sent_count) VALUES ($1,'anthropic',1)
           ON CONFLICT (bucket, provider) DO UPDATE SET sent_count = email_quota_usage.sent_count + 1 RETURNING sent_count`,
          [dayBucket()]
        );
        return Number(r.rows[0].sent_count);
      }
    });
  }
  return new MockAiProvider();
}
export type { AiProvider } from './types.js';
