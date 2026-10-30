import { execSync } from 'node:child_process';
import path from 'node:path';
export default async function globalSetup() {
  const api = path.resolve(__dirname, '../../api');
  const out = execSync('npx tsx tests/e2e-seed.ts', { cwd: api, env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'error' }, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
  console.log('[e2e seed]', out.trim().split('\n').pop());
}
