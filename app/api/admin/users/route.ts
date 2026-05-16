import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/require-user';

export const maxDuration = 30;

export async function GET() {
  const auth = await requireUser(['admin']);
  if ('error' in auth) return auth.error;

  const { data, error } = await auth.sb
    .from('profiles')
    .select('id, email, display_name, role, created_at')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ users: data });
}
