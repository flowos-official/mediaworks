import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export function getServiceClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(supabaseUrl, serviceKey);
}

export type Product = {
  id: string;
  name: string;
  description: string | null;
  file_url: string;
  file_name: string;
  status: 'pending' | 'analyzing' | 'extracted' | 'completed' | 'failed';
  created_at: string;
};

export type ResearchResult = {
  id: string;
  product_id: string;
  marketability_score: number;
  marketability_description: string;
  demographics: {
    age_group: string;
    gender: string;
    interests: string[];
    income_level: string;
  };
  seasonality: Record<string, number>; // month -> score 0-100
  cogs_estimate: {
    items: Array<{
      supplier: string;
      estimated_cost: string;
      moq: string;
      link?: string;
    }>;
    summary: string;
  };
  influencers: Array<{
    name: string;
    platform: string;
    followers: string;
    match_reason: string;
    profile_url?: string;
  }>;
  content_ideas: Array<{
    title: string;
    description: string;
    format: string;
  }>;
  raw_json: Record<string, unknown>;
  created_at: string;
};
