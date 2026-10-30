export interface SignalDef {
  weight: number;
  label: string;
  evidence_field: string;
  expect: boolean | string | number;
  inference_ok?: boolean; // AI çıkarımı bu sinyali besleyebilir mi? (yoksa yalnız gözlem)
}
export interface SectorConfig {
  key: string;
  name: string;
  description?: string;
  discovery: { queries: string[]; google_place_types?: string[]; exclude_name_patterns?: string[] };
  signals: Record<string, SignalDef>;
  qualification_threshold: number;
  service_preference: string[];
  message_angles: Record<string, string>;
  compliance: {
    requires_legal_review_for_campaign: boolean;
    collect_health_data: boolean;
    ai_assistant_restrictions?: string[];
    special_notes?: string;
  };
}
