#!/usr/bin/env node
/** n8n workflow JSON dosyalarının yapısal tutarlılığını kontrol eder (import öncesi). */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../n8n');
let failed = false;
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const wf = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  const errors = [];
  if (!wf.name || !Array.isArray(wf.nodes) || typeof wf.connections !== 'object') errors.push('name/nodes/connections eksik');
  const names = new Set();
  const ids = new Set();
  for (const n of wf.nodes) {
    if (!n.id || !n.name || !n.type || n.typeVersion == null || !Array.isArray(n.position)) errors.push(`düğüm eksik alan: ${n.name ?? '?'}`);
    if (names.has(n.name)) errors.push(`mükerrer düğüm adı: ${n.name}`);
    if (ids.has(n.id)) errors.push(`mükerrer id: ${n.id}`);
    names.add(n.name); ids.add(n.id);
    if (n.type === 'n8n-nodes-base.httpRequest' && !/\$env\.BAYS_API_URL/.test(n.parameters?.url ?? '')) errors.push(`HTTP düğümü BAYS_API_URL kullanmıyor: ${n.name}`);
    if (n.type === 'n8n-nodes-base.crypto' && !/BAYS_N8N_SHARED_SECRET/.test(n.parameters?.secret ?? '')) errors.push(`Crypto düğümü paylaşılan sırrı kullanmıyor: ${n.name}`);
    if (n.type === 'n8n-nodes-base.code' && /require\(/.test(n.parameters?.jsCode ?? '')) errors.push(`Code düğümü require() kullanıyor (NODE_FUNCTION_ALLOW_BUILTIN gerekir): ${n.name}`);
  }
  for (const [from, c] of Object.entries(wf.connections)) {
    if (!names.has(from)) errors.push(`bağlantı kaynağı yok: ${from}`);
    for (const outs of c.main ?? []) for (const o of outs ?? []) if (!names.has(o.node)) errors.push(`bağlantı hedefi yok: ${from} → ${o.node}`);
  }
  const triggers = wf.nodes.filter((n) => /Trigger|emailReadImap|webhook/i.test(n.type));
  if (!triggers.length) errors.push('tetikleyici yok');
  if (wf.active) errors.push('workflow active=true ile teslim edilmemeli');
  console.log(`${errors.length ? 'FAIL' : 'OK  '} ${f} — ${wf.nodes.length} düğüm, ${triggers.length} tetikleyici${errors.length ? '\n  - ' + errors.join('\n  - ') : ''}`);
  if (errors.length) failed = true;
}
process.exit(failed ? 1 : 0);
