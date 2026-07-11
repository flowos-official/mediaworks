'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { localePath } from '@/lib/i18n/locale-path';

export default function LocaleError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { locale = 'ja' } = useParams<{ locale?: string }>();
  const isKo = locale === 'ko';

  useEffect(() => {
    console.error('[route-error]', error);
  }, [error]);

  return (
    <main className="mw-page flex min-h-[70dvh] items-center justify-center">
      <section className="mw-panel w-full max-w-xl p-6 text-center sm:p-8" role="alert">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-amber-300 bg-amber-500/10 text-amber-700 dark:border-amber-900/50 dark:text-amber-300">
          <AlertTriangle size={22} />
        </div>
        <h1 className="mt-4 text-xl font-semibold text-foreground">{isKo ? '화면을 불러오지 못했습니다' : '画面を読み込めませんでした'}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {isKo ? '일시적인 연결 문제일 수 있습니다. 다시 시도해도 해결되지 않으면 홈으로 돌아가 다른 작업을 계속하세요.' : '一時的な接続問題の可能性があります。再試行しても解消しない場合は、ホームに戻って別の作業を続けてください。'}
        </p>
        {error.digest && <p className="mt-3 font-mono text-[10px] text-muted-foreground">ID: {error.digest}</p>}
        <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
          <button type="button" onClick={reset} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
            <RefreshCw size={15} /> {isKo ? '다시 시도' : '再試行'}
          </button>
          <Link href={localePath(locale, '/')} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground hover:bg-muted">
            <Home size={15} /> {isKo ? '홈으로' : 'ホームへ戻る'}
          </Link>
        </div>
      </section>
    </main>
  );
}
