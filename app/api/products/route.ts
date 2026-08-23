import { requireUser } from "@/lib/auth/require-user";
import { NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { filterMarketRecords } from '@/lib/market/data-visibility';

export async function GET() {
	// auth: requireUser
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

  const supabase = getServiceClient();
  
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ products: filterMarketRecords(data ?? []) });
}
