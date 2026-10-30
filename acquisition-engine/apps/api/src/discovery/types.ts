export interface DiscoveredBusiness {
  source_key: string;
  external_id?: string | null;      // ör. Google place id
  name: string;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  district?: string | null;
  address?: string | null;
  rating?: number | null;
  review_count?: number | null;
  instagram_handle?: string | null;
  types?: string[];
  evidence_url?: string | null;
}

export interface DiscoveryProvider {
  key: string;
  search(params: { query: string; city: string; sectorKey: string; limit: number }): Promise<DiscoveredBusiness[]>;
}

export interface WebsiteFacts {
  fetched: boolean;
  url?: string;
  status?: number;
  title?: string | null;
  has_whatsapp_link: boolean;
  has_online_booking: boolean;
  has_instagram: boolean;
  instagram_handle?: string | null;
  emails: string[];
  phones: string[];
  blocked_by_robots?: boolean;
  error?: string;
}
