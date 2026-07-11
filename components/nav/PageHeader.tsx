import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import ActivePageTitle from './ActivePageTitle';

interface PageHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  eyebrow?: string;
}

export default function PageHeader({
  icon: Icon,
  title,
  subtitle,
  action,
  eyebrow = 'Operational workspace',
}: PageHeaderProps) {
  return (
    <header className="mw-group-page-header relative mb-5 overflow-hidden rounded-2xl border border-border bg-card/88 px-4 py-4 shadow-sm backdrop-blur sm:px-5 sm:py-5 lg:mb-6">
      <span className="absolute inset-y-0 left-0 w-1 bg-primary" aria-hidden="true" />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/18 bg-primary/10 text-primary">
            <Icon size={18} />
          </span>
          <div className="min-w-0">
            <div className="mw-kicker mb-1">{eyebrow}</div>
            <ActivePageTitle fallbackTitle={title} subtitle={subtitle} />
          </div>
        </div>
        {action && <div className="shrink-0 sm:max-w-[55%]">{action}</div>}
      </div>
    </header>
  );
}
