'use client';

import UserMenu from '@/components/UserMenu';
import { ThemeMenu } from '@/components/theme/ThemeSubmenu';
import QuickNav from '@/components/nav/QuickNav';
import type { Role } from '@/lib/auth/route-permissions';

interface WorkspaceControlsProps {
  email: string | null;
  role: Role | null;
  locale: string;
  variant: 'mobile' | 'desktop';
}

export default function WorkspaceControls({ email, role, locale, variant }: WorkspaceControlsProps) {
  if (variant === 'mobile') {
    return (
      <>
        {role && <QuickNav role={role} locale={locale} variant="mobile" />}
        <ThemeMenu />
        <UserMenu email={email} role={role} locale={locale} triggerId="user-menu-trigger-mobile" />
      </>
    );
  }

  return (
    <div className="mw-workspace-controls space-y-1.5">
      {role && <QuickNav role={role} locale={locale} variant="desktop" />}
      <div className="mw-workspace-user-row flex items-center gap-1 rounded-xl bg-sidebar-accent/35 p-1">
        <div className="mw-workspace-account min-w-0 flex-1">
          <UserMenu email={email} role={role} locale={locale} triggerId="user-menu-trigger-desktop" />
        </div>
        <ThemeMenu />
      </div>
    </div>
  );
}
