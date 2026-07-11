import type { ReactNode } from 'react';

export default function DocumentLayout({ children }: { children: ReactNode }) {
  return <main className="mw-page">{children}</main>;
}
