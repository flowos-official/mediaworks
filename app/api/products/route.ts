import { requireUser } from "@/lib/auth/require-user";
import { NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

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

  return NextResponse.json({ products: data });
}
