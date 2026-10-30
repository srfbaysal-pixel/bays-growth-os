export interface InferenceInput {
  sectorKey: string;
  business: { name: string; website?: string | null; city?: string | null; review_count?: number | null; rating?: number | null };
  observations: Array<{ field: string; value: unknown; source: string }>;
  siteTitle?: string | null;
  candidateFields: string[]; // yalnız inference_ok sinyallerinin alanları
}
export interface InferenceOutput { inferences: Array<{ field: string; value: boolean; confidence: number; rationale: string }> }

export interface DraftInput {
  sectorKey: string;
  sectorName: string;
  channel: 'email' | 'whatsapp' | 'instagram' | 'linkedin' | 'phone';
  business: { name: string; city?: string | null };
  serviceName: string;
  angle: string;
  facts: Array<{ id: string; field: string; value: unknown; label: string }>;
  restrictions: string[];
  senderName: string;
}
export interface DraftOutput { subject: string | null; body: string; facts_used: string[] }

export interface ClassifyInput { subject?: string | null; body: string; language?: string }
export type ReplyClass = 'interested' | 'rejected' | 'question' | 'meeting_request' | 'out_of_office' | 'bounce' | 'unknown';
export interface ClassifyOutput { classification: ReplyClass; confidence: number; summary: string }

export interface AiProvider {
  key: string;
  infer(input: InferenceInput): Promise<InferenceOutput>;
  draft(input: DraftInput): Promise<DraftOutput>;
  classify(input: ClassifyInput): Promise<ClassifyOutput>;
}
