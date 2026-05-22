import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface PageHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

export default function PageHeader({ icon: Icon, title, subtitle, action }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Icon size={20} className="text-blue-600" />
          <h1 className="text-2xl font-bold text-foreground">{title}</h1>
        </div>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
