'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';

type Role = 'admin' | 'member' | 'viewer';
type Row = {
  id: string;
  email: string;
  display_name: string | null;
  company_name: string | null;
  role: Role;
  must_change_password: boolean;
  created_at: string;
};

type Credentials = {
  email: string;
  password: string;
  role: Role;
  displayName: string | null;
  companyName: string | null;
};

// Same alphabet/shape as the API generator — kept client-side only as a UX
// preview before submit (the server still generates the real one if blank).
function previewPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const symbol = '!@#$%^&*';
  const all = upper + lower + digit + symbol;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const out = [
    upper[bytes[0] % upper.length],
    lower[bytes[1] % lower.length],
    digit[bytes[2] % digit.length],
    symbol[bytes[3] % symbol.length],
  ];
  for (let i = 4; i < 16; i++) out.push(all[bytes[i] % all.length]);
  const shuf = new Uint8Array(16);
  crypto.getRandomValues(shuf);
  for (let i = out.length - 1; i > 0; i--) {
    const j = shuf[i] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

export default function UsersTable({ initial, currentUserId }: { initial: Row[]; currentUserId: string }) {
  const t = useTranslations('admin.users');
  const [rows, setRows] = useState<Row[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; displayName: string; companyName: string } | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newCompany, setNewCompany] = useState('');
  const [newRole, setNewRole] = useState<Role>('member');
  const [newPassword, setNewPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  function resetCreateForm() {
    setNewEmail('');
    setNewName('');
    setNewCompany('');
    setNewPassword('');
    setNewRole('member');
    setCreateErr(null);
  }

  function closeCreate() {
    setCreateOpen(false);
    resetCreateForm();
  }

  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function changeRole(id: string, role: Role) {
    setBusy(id);
    const r = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    setBusy(null);
    if (r.ok) {
      setRows((prev) => prev.map((row) => (row.id === id ? { ...row, role } : row)));
    } else {
      const j = await r.json().catch(() => ({}));
      alert((j as { error?: string }).error ?? 'failed');
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusy(editing.id);
    const r = await fetch(`/api/admin/users/${editing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: editing.displayName,
        companyName: editing.companyName,
      }),
    });
    setBusy(null);
    if (r.ok) {
      setRows((prev) => prev.map((row) =>
        row.id === editing.id
          ? { ...row, display_name: editing.displayName || null, company_name: editing.companyName || null }
          : row,
      ));
      setEditing(null);
    } else {
      const j = await r.json().catch(() => ({}));
      alert((j as { error?: string }).error ?? 'failed');
    }
  }

  async function remove(id: string) {
    if (!confirm(t('confirmDelete'))) return;
    setBusy(id);
    const r = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    setBusy(null);
    if (r.ok) setRows((prev) => prev.filter((row) => row.id !== id));
    else {
      const j = await r.json().catch(() => ({}));
      alert((j as { error?: string }).error ?? 'failed');
    }
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setCreateErr(null);
    setCreating(true);
    const r = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: newEmail.trim(),
        role: newRole,
        password: newPassword.trim() || undefined,
        displayName: newName.trim() || undefined,
        companyName: newCompany.trim() || undefined,
      }),
    });
    setCreating(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const errMsg = (j as { error?: string }).error ?? '';
      if (r.status === 409) setCreateErr(t('create.errorDuplicate'));
      else setCreateErr(errMsg || t('create.errorGeneric'));
      return;
    }
    const body = await r.json() as { user: Row; password: string };
    setRows((prev) => [body.user, ...prev]);
    setCredentials({
      email: body.user.email,
      password: body.password,
      role: body.user.role,
      displayName: body.user.display_name,
      companyName: body.user.company_name,
    });
    closeCreate();
  }

  async function copy(field: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(field);
    setTimeout(() => setCopied(null), 1500);
  }

  async function copyAll() {
    if (!credentials) return;
    const loginUrl = typeof window !== 'undefined' ? `${window.location.origin}/login` : '/login';
    const lines = [
      `${t('credentials.fieldEmail')}: ${credentials.email}`,
      `${t('credentials.fieldPassword')}: ${credentials.password}`,
      `${t('credentials.fieldRole')}: ${t(`roles.${credentials.role}`)}`,
      credentials.displayName ? `${t('credentials.fieldName')}: ${credentials.displayName}` : null,
      credentials.companyName ? `${t('credentials.fieldCompany')}: ${credentials.companyName}` : null,
      `${t('credentials.loginAt')}: ${loginUrl}`,
    ].filter(Boolean).join('\n');
    await copy('all', lines);
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>{t('create.openButton')}</Button>
      </div>

      <div className="border rounded overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-muted">
            <tr className="border-b text-foreground">
              <th className="text-left p-3 font-medium">{t('columnsExt.name')}</th>
              <th className="text-left p-3 font-medium">{t('columnsExt.company')}</th>
              <th className="text-left p-3 font-medium">{t('columns.email')}</th>
              <th className="text-left p-3 font-medium">{t('columns.role')}</th>
              <th className="text-left p-3 font-medium">{t('columnsExt.mustChange')}</th>
              <th className="text-left p-3 font-medium">{t('columns.created')}</th>
              <th className="text-right p-3 font-medium">{t('columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isEditing = editing?.id === row.id;
              return (
                <tr key={row.id} className="border-b hover:bg-muted/50">
                  <td className="p-3">
                    {isEditing ? (
                      <input
                        type="text" value={editing.displayName}
                        onChange={(e) => setEditing({ ...editing, displayName: e.target.value })}
                        className="border rounded px-2 py-1 w-full"
                      />
                    ) : (
                      <span>{row.display_name ?? <span className="text-muted-foreground">—</span>}</span>
                    )}
                  </td>
                  <td className="p-3">
                    {isEditing ? (
                      <input
                        type="text" value={editing.companyName}
                        onChange={(e) => setEditing({ ...editing, companyName: e.target.value })}
                        className="border rounded px-2 py-1 w-full"
                      />
                    ) : (
                      <span>{row.company_name ?? <span className="text-muted-foreground">—</span>}</span>
                    )}
                  </td>
                  <td className="p-3 font-mono text-xs">
                    {row.email}
                    {row.id === currentUserId && <Badge className="ml-2">you</Badge>}
                  </td>
                  <td className="p-3">
                    <select
                      value={row.role}
                      onChange={(e) => changeRole(row.id, e.target.value as Role)}
                      disabled={busy === row.id || row.id === currentUserId || isEditing}
                      className="border rounded px-2 py-1"
                    >
                      <option value="viewer">{t('roles.viewer')}</option>
                      <option value="member">{t('roles.member')}</option>
                      <option value="admin">{t('roles.admin')}</option>
                    </select>
                  </td>
                  <td className="p-3">
                    {row.must_change_password
                      ? <Badge className="bg-amber-600/15 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-900/40">{t('mustChangeYes')}</Badge>
                      : <span className="text-xs text-muted-foreground">{t('mustChangeNo')}</span>}
                  </td>
                  <td className="p-3 text-muted-foreground">{new Date(row.created_at).toISOString().slice(0,10)}</td>
                  <td className="p-3 text-right whitespace-nowrap">
                    {isEditing ? (
                      <>
                        <Button size="sm" onClick={saveEdit} disabled={busy === row.id} className="mr-1">
                          {t('save')}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setEditing(null)} disabled={busy === row.id}>
                          {t('cancel')}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="outline" size="sm"
                          onClick={() => setEditing({
                            id: row.id,
                            displayName: row.display_name ?? '',
                            companyName: row.company_name ?? '',
                          })}
                          disabled={busy === row.id}
                          className="mr-1"
                        >
                          {t('edit')}
                        </Button>
                        <Button
                          variant="outline" size="sm"
                          onClick={() => remove(row.id)}
                          disabled={busy === row.id || row.id === currentUserId}
                        >
                          {t('delete')}
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
          onClick={(e) => { if (e.target === e.currentTarget && !creating) closeCreate(); }}
        >
          <Card className="w-full max-w-lg p-6 space-y-4">
            <div>
              <h2 className="font-bold text-lg">{t('create.heading')}</h2>
              <p className="text-xs text-muted-foreground mt-1">{t('create.forceChangeHint')}</p>
            </div>
            <form onSubmit={createUser} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs text-foreground">{t('create.nameLabel')}</span>
                  <input
                    type="text" value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="mt-1 w-full border rounded px-3 py-2"
                    autoComplete="off"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-foreground">{t('create.companyLabel')}</span>
                  <input
                    type="text" value={newCompany}
                    onChange={(e) => setNewCompany(e.target.value)}
                    className="mt-1 w-full border rounded px-3 py-2"
                    autoComplete="off"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-foreground">{t('create.emailLabel')}</span>
                  <input
                    type="email" required value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    className="mt-1 w-full border rounded px-3 py-2 font-mono text-sm"
                    autoComplete="off"
                    autoFocus
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-foreground">{t('create.roleLabel')}</span>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as Role)}
                    className="mt-1 w-full border rounded px-2 py-2"
                  >
                    <option value="viewer">{t('roles.viewer')}</option>
                    <option value="member">{t('roles.member')}</option>
                    <option value="admin">{t('roles.admin')}</option>
                  </select>
                </label>
              </div>
              <label className="block">
                <span className="text-xs text-foreground">{t('create.passwordLabel')}</span>
                <div className="mt-1 flex gap-2">
                  <input
                    type="text" value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={t('create.passwordPlaceholder')}
                    className="flex-1 border rounded px-3 py-2 font-mono text-sm"
                    autoComplete="off"
                    minLength={8}
                  />
                  <Button type="button" variant="outline" onClick={() => setNewPassword(previewPassword())}>
                    {t('create.passwordGenerate')}
                  </Button>
                </div>
              </label>
              {createErr && <p className="text-sm text-red-600">{createErr}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={closeCreate} disabled={creating}>
                  {t('create.cancel')}
                </Button>
                <Button type="submit" disabled={creating}>
                  {creating ? t('create.submitting') : t('create.submit')}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {credentials && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-lg p-6 space-y-4">
            <div className="flex items-start justify-between">
              <h3 className="font-bold text-lg">{t('credentials.title')}</h3>
              <Button size="sm" variant="outline" onClick={copyAll}>
                {copied === 'all' ? t('credentials.copied') : t('credentials.copyAll')}
              </Button>
            </div>
            <p className="text-sm text-amber-900 dark:text-amber-100 bg-amber-600/10 border border-amber-300 dark:border-amber-800/40 rounded p-3">
              {t('credentials.hint')}
            </p>
            <div className="space-y-2">
              {credentials.displayName && (
                <CredRow label={t('credentials.fieldName')} value={credentials.displayName} />
              )}
              {credentials.companyName && (
                <CredRow label={t('credentials.fieldCompany')} value={credentials.companyName} />
              )}
              <CredRow
                label={t('credentials.fieldEmail')}
                value={credentials.email}
                onCopy={() => copy('email', credentials.email)}
                copied={copied === 'email'}
                copyLabel={t('credentials.copy')}
                copiedLabel={t('credentials.copied')}
                mono
              />
              <CredRow
                label={t('credentials.fieldPassword')}
                value={credentials.password}
                onCopy={() => copy('password', credentials.password)}
                copied={copied === 'password'}
                copyLabel={t('credentials.copy')}
                copiedLabel={t('credentials.copied')}
                mono
                highlight
              />
              <CredRow label={t('credentials.fieldRole')} value={t(`roles.${credentials.role}`)} />
              <CredRow
                label={t('credentials.loginAt')}
                value={typeof window !== 'undefined' ? `${window.location.origin}/login` : '/login'}
                mono
              />
            </div>
            <div className="flex justify-end">
              <Button onClick={() => setCredentials(null)}>{t('credentials.close')}</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function CredRow({
  label, value, onCopy, copied, copyLabel, copiedLabel, mono, highlight,
}: {
  label: string;
  value: string;
  onCopy?: () => void;
  copied?: boolean;
  copyLabel?: string;
  copiedLabel?: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="grid grid-cols-[100px_1fr_auto] items-center gap-3 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <code
        className={[
          'px-3 py-2 rounded border text-sm break-all',
          mono ? 'font-mono' : '',
          highlight ? 'bg-amber-600/10 border-amber-300 dark:border-amber-800/40 text-amber-900 dark:text-amber-100 font-semibold tracking-wider text-base' : 'bg-muted',
        ].join(' ')}
      >
        {value}
      </code>
      {onCopy ? (
        <Button size="sm" variant="outline" onClick={onCopy}>
          {copied ? copiedLabel : copyLabel}
        </Button>
      ) : <span />}
    </div>
  );
}
