import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { requireUser } from '@/lib/auth/require-user';
import { getServiceClient } from '@/lib/supabase';
import type { Role } from '@/lib/auth/route-permissions';

export const maxDuration = 30;

const VALID_ROLES: Role[] = ['admin', 'member', 'viewer'];

function generatePassword(): string {
  // 16 chars, mix of upper/lower/digits/symbols, avoiding ambiguous (0/O, 1/l/I).
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const symbol = '!@#$%^&*';
  const all = upper + lower + digit + symbol;

  const bytes = randomBytes(16);
  const out: string[] = [
    upper[bytes[0] % upper.length],
    lower[bytes[1] % lower.length],
    digit[bytes[2] % digit.length],
    symbol[bytes[3] % symbol.length],
  ];
  for (let i = 4; i < 16; i++) out.push(all[bytes[i] % all.length]);
  // Fisher-Yates shuffle so guaranteed-class chars aren't always at the front.
  const shuffleBytes = randomBytes(16);
  for (let i = out.length - 1; i > 0; i--) {
    const j = shuffleBytes[i] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

export async function GET() {
  const auth = await requireUser(['admin']);
  if ('error' in auth) return auth.error;

  const { data, error } = await auth.sb
    .from('profiles')
    .select('id, email, display_name, company_name, role, must_change_password, created_at')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ users: data });
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(['admin']);
  if ('error' in auth) return auth.error;

  let body: {
    email?: string;
    role?: string;
    password?: string;
    displayName?: string;
    companyName?: string;
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }

  const email = body.email?.trim().toLowerCase();
  const role = (body.role ?? 'member') as Role;
  const displayName = body.displayName?.trim() || null;
  const companyName = body.companyName?.trim() || null;

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return NextResponse.json({ error: 'invalid email' }, { status: 400 });
  }
  if (!VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: 'invalid role' }, { status: 400 });
  }
  const customPassword = body.password?.trim();
  if (customPassword && customPassword.length < 8) {
    return NextResponse.json({ error: 'password must be 8+ chars' }, { status: 400 });
  }
  const password = customPassword || generatePassword();

  const service = getServiceClient();
  const { data: existingList } = await service.auth.admin.listUsers();
  if (existingList.users.some((u) => u.email?.toLowerCase() === email)) {
    return NextResponse.json({ error: 'email already registered' }, { status: 409 });
  }

  const { data: created, error: createErr } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    return NextResponse.json({ error: createErr?.message ?? 'create failed' }, { status: 500 });
  }

  // handle_new_user trigger inserted profile with role='viewer'; override here.
  // must_change_password=true so login redirects them to set their own password.
  const { error: profErr } = await service
    .from('profiles')
    .update({
      role,
      display_name: displayName,
      company_name: companyName,
      must_change_password: true,
    })
    .eq('id', created.user.id);
  if (profErr) {
    return NextResponse.json({ error: `created but profile update failed: ${profErr.message}` }, { status: 500 });
  }

  return NextResponse.json({
    user: {
      id: created.user.id,
      email,
      role,
      display_name: displayName,
      company_name: companyName,
      must_change_password: true,
      created_at: created.user.created_at,
    },
    password,
  }, { status: 201 });
}
