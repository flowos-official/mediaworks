import Image from 'next/image';
import { BarChart3 } from 'lucide-react';
import { appConfig } from '@/config/app';

interface BrandIdentityProps {
  variant: 'mobile' | 'sidebar';
}

export default function BrandIdentity({ variant }: BrandIdentityProps) {
  const { brand } = appConfig;
  const isSidebar = variant === 'sidebar';
  const hasLongName = brand.name.length > 12;

  return (
    <>
      <span
        className={
          isSidebar
            ? 'flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_6px_18px_rgba(37,99,235,0.2)]'
            : 'flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm'
        }
      >
        {brand.logoPath ? (
          <Image src={brand.logoPath} alt="" width={isSidebar ? 24 : 20} height={isSidebar ? 24 : 20} priority />
        ) : (
          <BarChart3 size={isSidebar ? 18 : 17} aria-hidden="true" />
        )}
      </span>
      <span className={isSidebar ? 'mw-sidebar-copy min-w-0' : undefined}>
        <span
          className={
            isSidebar
              ? `block font-bold tracking-[-0.025em] ${hasLongName ? 'text-[12px]' : 'text-[15px]'}`
              : `block font-bold tracking-[-0.02em] ${hasLongName ? 'text-[11px]' : 'text-sm'}`
          }
        >
          {brand.name}
        </span>
        <span
          className={
            isSidebar
              ? 'block font-mono text-[9px] uppercase tracking-[0.16em] text-sidebar-foreground/65'
              : 'block font-mono text-[8px] uppercase tracking-[0.16em] text-muted-foreground/90'
          }
        >
          {isSidebar ? brand.descriptor : brand.mobileDescriptor}
          <span className="text-primary"> · {brand.marketLabel}</span>
        </span>
      </span>
    </>
  );
}
