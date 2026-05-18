'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

type Row = { id: string; email: string; role: 'admin'|'member'|'viewer'; created_at: string };

export default function UsersTable({ initial, currentUserId }: { initial: Row[]; currentUserId: string }) {
  const t = useTranslations('admin.users');
  const [rows, setRows] = useState<Row[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);

  async function changeRole(id: string, role: Row['role']) {
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

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b">
          <th className="text-left p-2">{t('columns.email')}</th>
          <th className="text-left p-2">{t('columns.role')}</th>
          <th className="text-left p-2">{t('columns.created')}</th>
          <th className="text-right p-2">{t('columns.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-b">
            <td className="p-2">{row.email}</td>
            <td className="p-2">
              <select
                value={row.role}
                onChange={(e) => changeRole(row.id, e.target.value as Row['role'])}
                disabled={busy === row.id || row.id === currentUserId}
                className="border rounded px-2 py-1"
              >
                <option value="viewer">{t('roles.viewer')}</option>
                <option value="member">{t('roles.member')}</option>
                <option value="admin">{t('roles.admin')}</option>
              </select>
              {row.id === currentUserId && <Badge className="ml-2">you</Badge>}
            </td>
            <td className="p-2">{new Date(row.created_at).toISOString().slice(0,10)}</td>
            <td className="p-2 text-right">
              <Button
                variant="outline" size="sm"
                onClick={() => remove(row.id)}
                disabled={busy === row.id || row.id === currentUserId}
              >
                {t('delete')}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
