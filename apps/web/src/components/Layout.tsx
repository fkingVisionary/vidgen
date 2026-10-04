import { useQuery } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Link, useLocation, useNavigationType } from 'react-router';
import { api } from '../api.ts';

/** Opens each newly visited page at the top; Back and Forward keep the browser's own scroll restoration. */
function ScrollToTop() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  useEffect(() => {
    if (navigationType !== 'POP') window.scrollTo(0, 0);
  }, [pathname, navigationType]);
  return null;
}

export function Layout({ children }: { children: ReactNode }) {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 });
  const h = health.data;
  return (
    <div className="min-h-screen">
      <ScrollToTop />
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/" className="font-semibold tracking-tight">
            Documentary Engine <span className="ml-1 rounded bg-stone-100 px-1.5 py-0.5 text-xs font-normal text-stone-500">V1</span>
          </Link>
          <div className="flex items-center gap-2 text-xs text-stone-500">
            <span className={`inline-block h-2 w-2 rounded-full ${health.isError ? 'bg-red-500' : h?.status === 'ok' ? 'bg-emerald-500' : 'bg-amber-400'}`} />
            {health.isError ? 'API unreachable' : h ? `API ${h.status} · DB ${h.database} · worker ${h.worker} · v${h.version}` : 'connecting…'}
          </div>
        </div>
      </header>
      {h?.mockMode && (
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">
          <strong>MOCK MODE</strong> — {h.providers.filter((p) => p.mock).map((p) => p.kind.toLowerCase()).join(', ')} providers are mocks.
          Job outputs are labelled placeholders: nothing is researched, voiced, generated, rendered or published.
        </div>
      )}
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
