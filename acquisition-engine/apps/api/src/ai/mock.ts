import type { AiProvider, ClassifyInput, ClassifyOutput, DraftInput, DraftOutput, InferenceInput, InferenceOutput } from './types.js';
import { renderTemplateDraft } from '../outreach/templates.js';
import { classifyByRules } from '../inbound/classify.js';

/** Deterministik mock: dış çağrı yapmaz. Gerçek model kalitesini temsil etmez. */
export class MockAiProvider implements AiProvider {
  key = 'mock';
  async infer(input: InferenceInput): Promise<InferenceOutput> {
    const inferences: InferenceOutput['inferences'] = [];
    for (const f of input.candidateFields) {
      if (f === 'multi_branch' || f === 'multi_practitioner') {
        const hint = /(şube|branch|klinikleri|merkezleri|hekimlerimiz|ekibimiz)/i.test(input.siteTitle ?? '');
        inferences.push({ field: f, value: hint, confidence: hint ? 0.6 : 0.3, rationale: 'mock: başlıkta anahtar kelime' });
      } else if (f === 'social_posting_irregular') {
        inferences.push({ field: f, value: true, confidence: 0.4, rationale: 'mock: veri yok, düşük güven' });
      } else if (f === 'seasonal_enrollment_pressure') {
        const m = new Date().getMonth();
        inferences.push({ field: f, value: m >= 5 && m <= 9, confidence: 0.5, rationale: 'mock: takvim' });
      }
    }
    return { inferences };
  }
  async draft(input: DraftInput): Promise<DraftOutput> {
    return renderTemplateDraft(input);
  }
  async classify(input: ClassifyInput): Promise<ClassifyOutput> {
    const r = classifyByRules(input.subject ?? '', input.body);
    return { classification: r.classification, confidence: r.confidence, summary: 'mock: kural tabanlı' };
  }
}
