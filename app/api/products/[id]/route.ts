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

  return NextResponse.json({ product, research });
}
