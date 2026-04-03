import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = getServiceClient();
  
  const { data: product, error: productError } = await supabase
    .from('products')
    .select('*')
    .eq('id', id)
    .single();

  if (productError) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 });
  }

  const { data: research } = await supabase
    .from('research_results')
    .select('*')
    .eq('product_id', id)
    .single();

  // Merge extended fields from raw_json.research (distribution_channels, live_commerce, etc.)
  // These fields may not have dedicated DB columns but are stored in raw_json
  let mergedResearch = research;
  if (research?.raw_json?.research) {
    const { raw_json, ...dbFields } = research;
    const rawResearch = raw_json.research as Record<string, unknown>;
    mergedResearch = { ...rawResearch, ...dbFields, raw_json };
  }

  return NextResponse.json({ product, research: mergedResearch });
}
