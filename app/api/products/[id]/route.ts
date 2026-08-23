import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { isMarketRecordVisible } from '@/lib/market/data-visibility';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
	// auth: requireUser
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

  const { id } = await params;
  const supabase = getServiceClient();
  
  const { data: product, error: productError } = await supabase
    .from('products')
    .select('*')
    .eq('id', id)
    .single();

  if (productError || !product || !isMarketRecordVisible(product)) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 });
  }

  const { data: research } = await supabase
    .from('research_results')
    .select('*')
    .eq('product_id', id)
    .single();

  return NextResponse.json({ product, research });
}
