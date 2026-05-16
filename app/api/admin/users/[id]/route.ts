import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/require-user';
import { getServiceClient } from '@/lib/supabase';
import type { Role } from '@/lib/auth/route-permissions';

const VALID: Role[] = ['admin', 'member', 'viewer'];

export const maxDuration = 30;

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(['admin']);
  if ('error' in auth) return auth.error;
  const { id } = await ctx.params;

  let body: { role?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }

  const role = body.role as Role | undefined;
  if (!role || !VALID.includes(role)) {
    return NextResponse.json({ error: 'invalid role' }, { status: 400 });
  }
  if (id === auth.user.id && role !== 'admin') {
    return NextResponse.json({ error: 'cannot demote yourself' }, { status: 400 });
  }

  const { error } = await auth.sb.from('profiles').update({ role }).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(['admin']);
  if ('error' in auth) return auth.error;
  const { id } = await ctx.params;

  if (id === auth.user.id) {
    return NextResponse.json({ error: 'cannot delete yourself' }, { status: 400 });
  }

  const service = getServiceClient();
  const { error } = await service.auth.admin.deleteUser(id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
