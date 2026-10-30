import type { AiProvider, ClassifyInput, ClassifyOutput, DraftInput, DraftOutput, InferenceInput, InferenceOutput } from './types.js';
import { renderTemplateDraft } from '../outreach/templates.js';
import { classifyByRules } from '../inbound/classify.js';

/**
 * Anthropic Messages API adaptörü (SDK'sız, fetch ile; bağımlılık yükü yok).
 * Belge: https://docs.claude.com/en/api/messages
 * Çıktılar şema ile doğrulanır; doğrulama başarısızsa güvenli geri dönüş (template / kurallar) kullanılır.
 */
export class AnthropicAiProvider implements AiProvider {
  key = 'anthropic';
  constructor(private opts: { apiKey: string; model: string; fetchFn?: typeof fetch; dailyLimit: number; counter: () => Promise<number> }) {}

  private async call(system: string, user: string, maxTokens = 800): Promise<string> {
    const used = await this.opts.counter();
    if (used > this.opts.dailyLimit) throw new Error('AI günlük çağrı limiti aşıldı (AI_DAILY_CALL_LIMIT)');
    const f = this.opts.fetchFn ?? fetch;
    const res = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.opts.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.opts.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as any;
    return (data.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
  }

  private parseJson<T>(text: string): T | null {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    try { return JSON.parse(m[0]) as T; } catch { return null; }
  }

  async infer(input: InferenceInput): Promise<InferenceOutput> {
    const system = 'Sen bir B2B araştırma asistanısın. YALNIZCA verilen gözlemlere dayanarak çıkarım yap; emin değilsen confidence düşük ver. Sağlık/kişisel veri çıkarımı yapma. Yalnız JSON döndür: {"inferences":[{"field":string,"value":boolean,"confidence":0-1,"rationale":string}]}';
    const user = JSON.stringify({ sector: input.sectorKey, business: input.business, site_title: input.siteTitle, observations: input.observations, fields: input.candidateFields });
    const out = this.parseJson<InferenceOutput>(await this.call(system, user));
    if (!out || !Array.isArray(out.inferences)) return { inferences: [] };
    const allowed = new Set(input.candidateFields);
    return {
      inferences: out.inferences
        .filter((i) => allowed.has(i.field) && typeof i.value === 'boolean')
        .map((i) => ({ field: i.field, value: i.value, confidence: Math.min(1, Math.max(0, Number(i.confidence) || 0)), rationale: String(i.rationale ?? '').slice(0, 300) }))
    };
  }

  async draft(input: DraftInput): Promise<DraftOutput> {
    const base = renderTemplateDraft(input);
    const system = [
      'Sen BaysSystems adına kısa, saygılı, Türkçe B2B tanışma mesajları yazan bir asistansın.',
      'KURALLAR: Yalnızca "facts" listesindeki bilgilere atıf yap; uydurma, varsayım veya abartı yok. Fiyat verme. Tıbbi/sağlık iddiası yapma.',
      'En fazla 110 kelime. Tek, net bir sonraki adım iste (15 dk görüşme). "Reddetmek için yanıtlamanız yeterli" ifadesi kalsın.',
      'Yalnız JSON döndür: {"subject": string|null, "body": string, "facts_used": [fact id]}'
    ].join('\n');
    const user = JSON.stringify({ sector: input.sectorName, channel: input.channel, business: input.business, service: input.serviceName, angle: input.angle, facts: input.facts, restrictions: input.restrictions, template_reference: base });
    const out = this.parseJson<DraftOutput>(await this.call(system, user));
    if (!out || typeof out.body !== 'string' || !out.body.trim()) return base;
    const validIds = new Set(input.facts.map((f) => f.id));
    return { subject: input.channel === 'email' ? (out.subject ?? base.subject) : null, body: out.body.trim(), facts_used: (out.facts_used ?? []).filter((id) => validIds.has(id)) };
  }

  async classify(input: ClassifyInput): Promise<ClassifyOutput> {
    const rules = classifyByRules(input.subject ?? '', input.body);
    if (rules.confidence >= 0.9) return { ...rules, summary: 'kural' };
    const system = 'Gelen satış e-postası yanıtını sınıflandır. Sınıflar: interested, rejected, question, meeting_request, out_of_office, bounce, unknown. Yalnız JSON: {"classification":..., "confidence":0-1, "summary": "<=120 karakter"}';
    const out = this.parseJson<ClassifyOutput>(await this.call(system, JSON.stringify({ subject: input.subject, body: input.body.slice(0, 4000) }), 300));
    const valid = new Set(['interested', 'rejected', 'question', 'meeting_request', 'out_of_office', 'bounce', 'unknown']);
    if (!out || !valid.has(out.classification)) return { ...rules, summary: 'kural (AI çıktı geçersiz)' };
    return { classification: out.classification, confidence: Math.min(1, Math.max(0, Number(out.confidence) || 0)), summary: String(out.summary ?? '').slice(0, 200) };
  }
}
