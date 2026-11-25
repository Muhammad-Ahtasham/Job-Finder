'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Briefcase,
  Building2,
  Download,
  FolderSearch,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  X,
} from 'lucide-react';
import type { MeResponse } from '@jobfinder/contracts';
import { fetchMe, logout } from '@/lib/api';
import { getActiveWorkspaceId, setActiveWorkspaceId } from '@/lib/workspace';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/projects', label: 'Search Projects', icon: FolderSearch },
  { href: '/companies', label: 'Companies', icon: Building2 },
  { href: '/jobs', label: 'Job Opportunities', icon: Briefcase },
  { href: '/exports', label: 'Exports', icon: Download },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

/** Redirects to /login when there is no session. The API remains the authority. */
export function useRequireAuth(): { me: MeResponse | null; isPending: boolean; isError: boolean } {
  const router = useRouter();
  const { data, isPending, isError } = useQuery({ queryKey: ['me'], queryFn: fetchMe });
  useEffect(() => {
    if (!isPending && !isError && !data) router.replace('/login');
  }, [data, isPending, isError, router]);
  return { me: data ?? null, isPending, isError };
}

/** The workspace requests are scoped to: the stored choice if the user belongs to it, else personal. */
export function useActiveWorkspace(me: MeResponse) {
  const stored = getActiveWorkspaceId();
  return (
    me.workspaces.find((w) => w.id === stored) ??
    me.workspaces.find((w) => w.isPersonal) ??
    me.workspaces[0]!
  );
}

function WorkspaceSwitcher({ me }: { me: MeResponse }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const active = useActiveWorkspace(me);
  if (me.workspaces.length < 2) {
    return <p className="truncate px-1 text-xs text-muted-foreground">{active.name}</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="workspace" className="px-1 text-xs text-muted-foreground">
        Workspace
      </label>
      <Select
        id="workspace"
        value={active.id}
        onChange={(event) => {
          setActiveWorkspaceId(event.target.value);
          // Nothing cached for the old workspace may be shown in the new one.
          queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
          router.push('/dashboard');
        }}
      >
        {me.workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
            {w.isPersonal ? ' (personal)' : ''}
          </option>
        ))}
      </Select>
    </div>
  );
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map(({ href, label, icon: Icon }) => {
        const current = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
              current
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ me, children }: { me: MeResponse; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const signOut = useMutation({
    mutationFn: logout,
    onSettled: () => {
      queryClient.clear();
      router.replace('/login');
    },
  });

  // Close the mobile menu after navigating.
  useEffect(() => setOpen(false), [pathname]);

  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-4">
      <Link href="/dashboard" className="px-3 text-base font-semibold tracking-tight">
        Job Intelligence
      </Link>
      <Nav onNavigate={() => setOpen(false)} />
      <div className="mt-auto flex flex-col gap-3 border-t pt-4">
        <WorkspaceSwitcher me={me} />
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="truncate text-xs text-muted-foreground" title={me.user.email}>
            {me.user.email}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
            aria-label="Sign out"
          >
            <LogOut className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:shadow"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-screen border-r bg-card lg:block">{sidebar}</aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b bg-background/95 px-4 py-2 backdrop-blur lg:hidden">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            aria-expanded={open}
            aria-controls="mobile-menu"
          >
            <Menu className="size-4" aria-hidden="true" />
          </Button>
          <span className="font-semibold">Job Intelligence</span>
        </header>

        {open && (
          <div
            className="fixed inset-0 z-40 lg:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
          >
            <button
              type="button"
              className="absolute inset-0 bg-black/40"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
            />
            <div id="mobile-menu" className="relative h-full w-64 bg-card shadow-xl">
              <Button
                variant="ghost"
                size="sm"
                className="absolute top-3 right-3"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
              {sidebar}
            </div>
          </div>
        )}

        <main id="content" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {/* useSearchParams (table state in the URL) needs a Suspense boundary. */}
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>{children}</Suspense>
        </main>
      </div>
    </div>
  );
}

/** Wraps a page: waits for the session, shows load/error states, then renders with the shell. */
export function AuthedPage({ children }: { children: (me: MeResponse) => ReactNode }) {
  const { me, isPending, isError } = useRequireAuth();
  if (isError) {
    return (
      <main className="p-8 text-sm text-destructive" role="alert">
        Could not reach the API. Is it running?
      </main>
    );
  }
  if (isPending || !me) {
    return (
      <main className="p-8" aria-busy="true">
        <Skeleton className="h-8 w-48" />
      </main>
    );
  }
  return <AppShell me={me}>{children(me)}</AppShell>;
}
