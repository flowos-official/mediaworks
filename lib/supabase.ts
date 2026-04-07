import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Lazy singletons — never construct Supabase clients at module load time, otherwise
// Supabase auth's setInterval-based token refresh runs at import time and crashes
// inside the Vercel Workflow sandbox (which forbids setTimeout/setInterval).
let _supabase: SupabaseClient | null = null;
let _serviceClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _supabase;
}

export function getServiceClient(): SupabaseClient {
  if (!_serviceClient) {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    _serviceClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _serviceClient;
}

// Backwards-compat proxy: lets existing `import { supabase } from '@/lib/supabase'`
// work without eager construction. Methods are forwarded on first access.
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return Reflect.get(getSupabase(), prop, getSupabase());
  },
}) as SupabaseClient;

export type Product = {
  id: string;
  name: string;
  description: string | null;
  file_url: string;
  file_name: string;
  status: 'pending' | 'extracted' | 'analyzing' | 'completed' | 'failed';
  created_at: string;
};

export type ProductFile = {
  id: string;
  product_id: string;
  file_url: string;
  file_name: string;
  mime_type: string;
  is_primary: boolean;
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

export type SalesWeekly = {
  id: string;
  week_start: string;
  week_end: string;
  product_code: string;
  product_name: string;
  category: string | null;
  order_quantity: number;
  total_revenue: number;
  order_cost: number;
  gross_profit: number;
  wholesale_unit_price: number | null;
  purchase_unit_price: number | null;
  profit_per_unit: number | null;
  created_at: string;
};

export type SalesWeeklyTotal = {
  id: string;
  week_start: string;
  week_end: string;
  total_quantity: number;
  total_revenue: number;
  total_cost: number;
  total_gross_profit: number;
  created_at: string;
};

export type ProductDetail = {
  id: string;
  product_code: string;
  product_name: string;
  product_name_kana: string | null;
  category_txd1: string | null;
  category_txd2: string | null;
  supplier: string | null;
  txd_manager: string | null;
  sales_channels: { tv: boolean; ec: boolean; paper: boolean; other: boolean } | null;
  description: string | null;
  set_contents: string[] | null;
  skus: Array<{
    name: string;
    color: string;
    size: string;
    price_incl: number | null;
    price_excl: number | null;
    shipping: number | null;
  }> | null;
  return_policy: string | null;
  exchange_policy: string | null;
  care_instructions: string | null;
  usage_notes: string[] | null;
  faq: Array<{ question: string; answer: string }> | null;
  shipping_company: string | null;
  package_size: string | null;
  package_weight: number | null;
  jan_codes: string[] | null;
  wrapping: string | null;
  manufacturer: string | null;
  manufacturer_country: string | null;
  cost_price: number | null;
  wholesale_rate: number | null;
  supplier_contact: { company: string; person: string; tel: string; fax: string; email: string } | null;
  source_file: string | null;
  file_date: string | null;
  created_at: string;
};

export type ProductImage = {
  id: string;
  product_code: string;
  sheet_name: string | null;
  image_key: string;
  s3_url: string;
  mime_type: string;
  size_bytes: number | null;
  sort_order: number;
  created_at: string;
};

export type ProductSummary = {
  product_code: string;
  product_name: string;
  category: string | null;
  year: number;
  total_quantity: number;
  total_revenue: number;
  total_cost: number;
  total_profit: number;
  week_count: number;
  avg_weekly_qty: number;
  margin_rate: number;
};

export type CategorySummary = {
  category: string;
  year: number;
  total_quantity: number;
  total_revenue: number;
  total_profit: number;
  product_count: number;
  margin_rate: number;
};

export type MonthlySummary = {
  product_code: string;
  year_month: string;
  quantity: number;
  revenue: number;
  profit: number;
};

export type AnnualSummary = {
  year: number;
  total_quantity: number;
  total_revenue: number;
  total_cost: number;
  total_profit: number;
  week_count: number;
  product_count: number;
  margin_rate: number;
};

export type MdStrategy = {
  id: string;
  user_goal: string | null;
  category: string | null;
  target_market: string | null;
  price_range: string | null;
  product_selection: Record<string, unknown> | null;
  channel_strategy: Record<string, unknown> | null;
  pricing_margin: Record<string, unknown> | null;
  marketing_execution: Record<string, unknown> | null;
  financial_projection: Record<string, unknown> | null;
  risk_contingency: Record<string, unknown> | null;
  created_at: string;
};
