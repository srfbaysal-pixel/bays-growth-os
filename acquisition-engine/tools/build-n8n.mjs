#!/usr/bin/env node
/**
 * Üç n8n workflow JSON dosyasını üretir (deterministik kimlikler).
 * Çalıştır: node tools/build-n8n.mjs  → n8n/*.json
 * Ortam değişkenleri (n8n tarafında): BAYS_API_URL, BAYS_N8N_SHARED_SECRET
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../n8n');
mkdirSync(outDir, { recursive: true });

const uuid = (seed) => { const h = createHash('sha1').update(seed).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

function wf(name, nodes, connections, extra = {}) {
  return {
    name, nodes, connections, active: false,
    settings: { executionOrder: 'v1', saveManualExecutions: true, saveExecutionProgress: true, timezone: 'Europe/Istanbul', ...extra.settings },
    meta: { templateCredsSetupCompleted: false, bays_acq_version: '1.0.0' },
    tags: [{ name: 'bays-acq' }],
    versionId: uuid(name + ':version')
  };
}
let x = 0;
const pos = (col, row = 0) => [col * 260, row * 220];
const node = (wfName, name, type, typeVersion, parameters, extra = {}) => ({ id: uuid(wfName + ':' + name), name, type, typeVersion, position: extra.position ?? pos(x++), parameters, ...(extra.rest ?? {}) });
const link = (connections, from, to, outputIndex = 0) => { (connections[from] ??= { main: [] }); (connections[from].main[outputIndex] ??= []).push({ node: to, type: 'main', index: 0 }); };

/** Ortak imzalama zinciri: Code(body+ts) → Crypto(HMAC) → HTTP Request */
function signedCall(wfName, connections, prefix, path, bodyExpr, prevNode, timeoutMs = 600000) {
  const build = node(wfName, `${prefix}: gövde`, 'n8n-nodes-base.code', 2, {
    mode: 'runOnceForEachItem', language: 'javaScript',
    jsCode: `// İstek gövdesini ve zaman damgasını hazırla (imza: HMAC-SHA256(ts + "." + body))\nconst payload = ${bodyExpr};\nconst body = JSON.stringify(payload);\nconst ts = String(Math.floor(Date.now() / 1000));\nreturn { json: { body, ts, signInput: ts + '.' + body } };`
  });
  const sign = node(wfName, `${prefix}: imza`, 'n8n-nodes-base.crypto', 1, { action: 'hmac', type: 'SHA256', value: '={{ $json.signInput }}', secret: '={{ $env.BAYS_N8N_SHARED_SECRET }}', dataPropertyName: 'signature', encoding: 'hex' });
  const http = node(wfName, `${prefix}: API`, 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: `={{ $env.BAYS_API_URL }}${path}`,
    sendHeaders: true, headerParameters: { parameters: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Bays-Timestamp', value: '={{ $json.ts }}' },
      { name: 'X-Bays-Signature', value: '=sha256={{ $json.signature }}' }
    ] },
    sendBody: true, contentType: 'raw', rawContentType: 'application/json', body: '={{ $json.body }}',
    options: { timeout: timeoutMs, response: { response: { fullResponse: false, neverError: false } } }
  }, { rest: { onError: 'continueRegularOutput', retryOnFail: false } });
  link(connections, prevNode, build.name); link(connections, build.name, sign.name); link(connections, sign.name, http.name);
  return { nodes: [build, sign, http], last: http.name };
}

function heartbeatOnError(wfName, connections, prefix, workflowKey, fromNode) {
  const check = node(wfName, `${prefix}: hata mı?`, 'n8n-nodes-base.if', 2.2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'or', conditions: [
      { id: uuid(wfName + prefix + 'c1'), leftValue: '={{ $json.error !== undefined }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } },
      { id: uuid(wfName + prefix + 'c2'), leftValue: '={{ Array.isArray($json.errors) && $json.errors.length > 0 }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }
    ] }, options: {}
  });
  link(connections, fromNode, check.name);
  const hb = signedCall(wfName, connections, `${prefix}: heartbeat`, '/internal/heartbeat', `{ workflow_key: '${workflowKey}', run_id: 'n8n-' + $execution.id + '-${prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-err', status: 'failed', error: String($json.error?.message ?? $json.error ?? ($json.errors ?? []).join('; ')).slice(0, 2000) }`, check.name);
  // IF true çıkışı (0) heartbeat'e, false çıkışı (1) boş
  connections[check.name].main[0] = [{ node: hb.nodes[0].name, type: 'main', index: 0 }];
  return { nodes: [check, ...hb.nodes] };
}

// ───────────────────────────── WF1 ─────────────────────────────
{
  x = 0; const W = 'BaysAcq WF1 — Lead Discovery & Qualification'; const c = {};
  const trigger = node(W, 'Her iş günü 08:00', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] } });
  const manual = node(W, 'Manuel tetikle', 'n8n-nodes-base.manualTrigger', 1, {}, { position: pos(0, 1) });
  const plan = node(W, 'Sektör × şehir planı', 'n8n-nodes-base.code', 2, {
    mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `// Pilot: her sektörde 30 nitelikli işletme. Şehir listesini burada düzenleyin.\nconst sectors = ['education', 'beauty', 'clinic'];\nconst cities = ($env.BAYS_PILOT_CITIES || 'İstanbul,Ankara,İzmir').split(',').map(s => s.trim()).filter(Boolean);\nconst targetPerSector = Number($env.BAYS_TARGET_PER_SECTOR || 30);\nconst items = [];\nfor (const sector_key of sectors) for (const city of cities) items.push({ json: { sector_key, city, target_qualified: targetPerSector, limit_per_query: 20 } });\nreturn items;`
  });
  link(c, trigger.name, plan.name); link(c, manual.name, plan.name);
  const loop = node(W, 'Sırayla işle', 'n8n-nodes-base.splitInBatches', 3, { batchSize: 1, options: {} });
  link(c, plan.name, loop.name);
  const call = signedCall(W, c, 'Keşif', '/internal/wf1/run', `{ run_id: 'n8n-' + $execution.id + '-' + $json.sector_key + '-' + $json.city, sector_key: $json.sector_key, city: $json.city, limit_per_query: $json.limit_per_query, target_qualified: $json.target_qualified }`, loop.name);
  // splitInBatches v3: çıkış 0 = done, çıkış 1 = loop
  c[loop.name].main = [[], [{ node: call.nodes[0].name, type: 'main', index: 0 }]];
  const hb = heartbeatOnError(W, c, 'Keşif', 'wf1_discovery', call.last);
  link(c, call.last, loop.name); // döngüye geri
  const summary = node(W, 'Özet', 'n8n-nodes-base.code', 2, { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// Döngü bitti: tüm sonuçları özetle (panel System Health bunu workflow_runs tablosundan okur)\nreturn [{ json: { finished_at: new Date().toISOString(), runs: $input.all().length } }];` }, { position: pos(x, 1) });
  c[loop.name].main[0] = [{ node: summary.name, type: 'main', index: 0 }];
  const notes = node(W, 'Notlar', 'n8n-nodes-base.stickyNote', 1, { content: `## WF1 — Lead Discovery & Qualification\n\nGerekli n8n ortam değişkenleri: **BAYS_API_URL** (ör. https://acq.bayssystem.com), **BAYS_N8N_SHARED_SECRET** (API .env ile aynı), opsiyonel **BAYS_PILOT_CITIES**, **BAYS_TARGET_PER_SECTOR**.\n\nAkış: sektör×şehir planı → her biri için imzalı POST /internal/wf1/run (keşif + web sitesi gözlemi + AI çıkarımı + puanlama + CRM kaydı; mükerrer önleme API'de).\n\nKeşif sağlayıcısı API .env'de seçilir (DISCOVERY_PROVIDER=mock|google_places|csv). Bu workflow hiçbir mesaj göndermez.`, height: 300, width: 520 }, { position: [0, -360] });
  writeFileSync(path.join(outDir, 'WF1_lead_discovery_qualification.json'), JSON.stringify(wf(W, [trigger, manual, plan, loop, ...call.nodes, ...hb.nodes, summary, notes], c), null, 2));
}

// ───────────────────────────── WF2 ─────────────────────────────
{
  x = 0; const W = 'BaysAcq WF2 — Outreach Preparation & Approval'; const c = {};
  const trigger = node(W, 'İş günleri 09-18 her 2 saat', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'cronExpression', expression: '0 9-18/2 * * 1-5' }] } });
  const manual = node(W, 'Manuel tetikle', 'n8n-nodes-base.manualTrigger', 1, {}, { position: pos(0, 1) });
  const start = node(W, 'Başlat', 'n8n-nodes-base.set', 3.4, { assignments: { assignments: [{ id: uuid(W + 'a1'), name: 'limit', value: '={{ Number($env.BAYS_WF2_PREPARE_LIMIT || 20) }}', type: 'number' }] }, options: {} });
  link(c, trigger.name, start.name); link(c, manual.name, start.name);
  const prep = signedCall(W, c, 'Taslak hazırla', '/internal/wf2/prepare', `{ run_id: 'n8n-' + $execution.id + '-prepare', limit: $json.limit }`, start.name);
  const hb1 = heartbeatOnError(W, c, 'Taslak hazırla', 'wf2_outreach', prep.last);
  const send = signedCall(W, c, 'Onaylıları gönder', '/internal/wf2/send', `{ run_id: 'n8n-' + $execution.id + '-send', limit: Number($env.BAYS_WF2_SEND_LIMIT || 10) }`, prep.last);
  const hb2 = heartbeatOnError(W, c, 'Onaylıları gönder', 'wf2_sender', send.last);
  const pausedCheck = node(W, 'Gönderim durdu mu?', 'n8n-nodes-base.if', 2.2, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and', conditions: [{ id: uuid(W + 'p1'), leftValue: '={{ $json.paused === true }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] }, options: {} }, { position: pos(x, 1) });
  link(c, send.last, pausedCheck.name);
  const alert = node(W, 'Durdurma uyarısı (e-posta/WhatsApp bağlayın)', 'n8n-nodes-base.noOp', 1, {}, { position: pos(x + 1, 1) });
  c[pausedCheck.name] = { main: [[{ node: alert.name, type: 'main', index: 0 }], []] };
  const notes = node(W, 'Notlar', 'n8n-nodes-base.stickyNote', 1, { content: `## WF2 — Outreach Preparation & Approval\n\n1) **/internal/wf2/prepare**: nitelikli lead'ler için hizmet önerisi + yalnız doğrulanmış kanıta dayalı taslak + doğrulama + kanal politikası → **onay kuyruğu** (panel → Approvals).\n2) **/internal/wf2/send**: yalnız panelde **insan onayı** almış ve politikası auto_send olan işleri gönderir. DRY_RUN=true iken sağlayıcıya gitmez. Kota/bounce/ardışık hata eşiklerinde gönderim durur (kill-switch) ve \`paused=true\` döner.\n\nOnay/ret/düzenleme panelde yapılır; n8n bu kararları vermez. Gönderim yetkisi yoksa API manuel iletişim görevi açar.\n\n"Durdurma uyarısı" düğümünü kendi bildirim kanalınıza (e-posta/WhatsApp) bağlayın.`, height: 340, width: 560 }, { position: [0, -400] });
  writeFileSync(path.join(outDir, 'WF2_outreach_preparation_approval.json'), JSON.stringify(wf(W, [trigger, manual, start, ...prep.nodes, ...hb1.nodes, ...send.nodes, ...hb2.nodes, pausedCheck, alert, notes], c), null, 2));
}

// ───────────────────────────── WF3 ─────────────────────────────
{
  x = 0; const W = 'BaysAcq WF3 — Reply & Sales Management'; const c = {};
  const imap = node(W, 'IMAP: gelen e-posta', 'n8n-nodes-base.emailReadImap', 2, { mailbox: 'INBOX', postProcessAction: 'read', format: 'resolved', options: { customEmailConfig: '["UNSEEN"]', forceReconnect: 60 } }, { rest: { credentials: { imap: { id: 'REPLACE_WITH_IMAP_CREDENTIAL_ID', name: 'BaysAcq IMAP' } } } });
  const normalize = node(W, 'E-postayı normalize et', 'n8n-nodes-base.code', 2, {
    mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `// IMAP düğümü çıktısını API'nin beklediği şekle çevir. Gövde metni 20k ile sınırlanır.\nconst addr = (v) => { if (!v) return ''; if (typeof v === 'string') return v; if (v.text) return v.text; if (Array.isArray(v.value)) return v.value.map(a => a.address).join(', '); if (v.address) return v.address; return String(v); };\nconst messages = $input.all().map(({ json: m }) => ({\n  provider_message_id: m.messageId || m.id || null,\n  from: addr(m.from),\n  to: addr(m.to) + (m.deliveredTo ? ', ' + addr(m.deliveredTo) : ''),\n  subject: m.subject || '',\n  text: String(m.text || m.textPlain || (m.html ? m.html.replace(/<[^>]+>/g, ' ') : '')).slice(0, 20000),\n  in_reply_to: m.inReplyTo || null,\n  references: Array.isArray(m.references) ? m.references.join(' ') : (m.references || null),\n  received_at: m.date ? new Date(m.date).toISOString() : null,\n  headers: { 'delivered-to': addr(m.deliveredTo || (m.headers && (m.headers['delivered-to'] || m.headers.get?.('delivered-to'))) ) }\n}));\nreturn [{ json: { messages } }];`
  });
  link(c, imap.name, normalize.name);
  const inbound = signedCall(W, c, 'Yanıtları işle', '/internal/wf3/inbound', `{ run_id: 'n8n-' + $execution.id + '-inbound', messages: $json.messages }`, normalize.name);
  const hb1 = heartbeatOnError(W, c, 'Yanıtları işle', 'wf3_replies', inbound.last);
  x = 0;
  const daily = node(W, 'Her gün 23:50 metrik', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'cronExpression', expression: '50 23 * * *' }] } }, { position: pos(0, 3) });
  const weekly = node(W, 'Pazartesi 07:30 haftalık', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'cronExpression', expression: '30 7 * * 1' }] } }, { position: pos(0, 4) });
  const setDaily = node(W, 'Günlük parametre', 'n8n-nodes-base.set', 3.4, { assignments: { assignments: [{ id: uuid(W + 'd1'), name: 'weekly', value: false, type: 'boolean' }] }, options: {} }, { position: pos(1, 3) });
  const setWeekly = node(W, 'Haftalık parametre', 'n8n-nodes-base.set', 3.4, { assignments: { assignments: [{ id: uuid(W + 'w1'), name: 'weekly', value: true, type: 'boolean' }] }, options: {} }, { position: pos(1, 4) });
  link(c, daily.name, setDaily.name); link(c, weekly.name, setWeekly.name);
  x = 2;
  const metrics = signedCall(W, c, 'Metrikleri hesapla', '/internal/wf3/metrics', `{ run_id: 'n8n-' + $execution.id + '-metrics', weekly: $json.weekly === true }`, setDaily.name);
  metrics.nodes.forEach((n, i) => { n.position = pos(2 + i, 3); });
  link(c, setWeekly.name, metrics.nodes[0].name);
  const hb2 = heartbeatOnError(W, c, 'Metrikleri hesapla', 'wf3_metrics', metrics.last);
  hb2.nodes.forEach((n, i) => { n.position = pos(5 + i, 3); });
  const report = node(W, 'Haftalık rapor (bildirim kanalınıza bağlayın)', 'n8n-nodes-base.noOp', 1, {}, { position: pos(5, 4) });
  link(c, metrics.last, report.name);
  const notes = node(W, 'Notlar', 'n8n-nodes-base.stickyNote', 1, { content: `## WF3 — Reply & Sales Management\n\n**A) Gelen yanıtlar**: IMAP tetikleyicisi (kimlik bilgisini n8n'de oluşturup bu düğüme bağlayın) → normalize → imzalı POST /internal/wf3/inbound. API: reply+token / Message-ID / kişi e-postası ile işletme eşleştirme, sınıflandırma (ilgi/ret/soru/görüşme/ofis dışı/bounce), ret → tüm kanallarda engelleme, fırsat + takip görevleri.\n\nIMAP bağlı değilken panel → Conversations → "Yanıt gir" ile manuel giriş yapılabilir.\n\n**B) Metrikler**: günlük 23:50 ve haftalık Pazartesi 07:30 → /internal/wf3/metrics (daily_metrics tablosu; panel Dashboard/Revenue buradan ve canlı sorgulardan okur).\n\nResend/WhatsApp teslimat webhook'ları doğrudan API'ye gider (/webhooks/...), n8n gerekmez.`, height: 380, width: 600 }, { position: [0, -420] });
  writeFileSync(path.join(outDir, 'WF3_reply_sales_management.json'), JSON.stringify(wf(W, [imap, normalize, ...inbound.nodes, ...hb1.nodes, daily, weekly, setDaily, setWeekly, ...metrics.nodes, ...hb2.nodes, report, notes], c), null, 2));
}
console.log('n8n workflow dosyaları yazıldı:', outDir);
