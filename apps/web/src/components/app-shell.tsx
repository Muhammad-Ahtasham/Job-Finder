'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@jobfinder/contracts';
import { fetchMe, logout } from '@/lib/api';
import { Button } from '@/components/ui/button';

/** Redirects to /login when there is no session. The API remains the authority. */
export function useRequireAuth(): { me: MeResponse | null; isPending: boolean; isError: boolean } {
  const router = useRouter();
  const { data, isPending, isError } = useQuery({ queryKey: ['me'], queryFn: fetchMe });
  useEffect(() => {
    if (!isPending && !isError && !data) router.replace('/login');
  }, [data, isPending, isError, router]);
  return { me: data ?? null, isPending, isError };
}

export function AppShell({ me, children }: { me: MeResponse; children: ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: logout,
    onSettled: () => {
      queryClient.clear();
      router.replace('/login');
    },
  });

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
          <nav className="flex items-center gap-5 text-sm">
            <Link href="/dashboard" className="font-semibold">
              Job Intelligence
            </Link>
            <Link href="/projects" className="text-muted-foreground hover:text-foreground">
              Projects
            </Link>
            <Link href="/reviews" className="text-muted-foreground hover:text-foreground">
              Reviews
            </Link>
          </nav>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="hidden sm:inline">{me.user.email}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => signOut.mutate()}
              disabled={signOut.isPending}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}

/** Wraps a page: waits for the session, shows load/error states, then renders with the shell. */
export function AuthedPage({ children }: { children: (me: MeResponse) => ReactNode }) {
  const { me, isPending, isError } = useRequireAuth();
  if (isError) {
    return (
      <main className="p-8 text-sm text-destructive">Could not reach the API. Is it running?</main>
    );
  }
  if (isPending || !me) {
    return <main className="p-8 text-sm text-muted-foreground">Loading…</main>;
  }
  return <AppShell me={me}>{children(me)}</AppShell>;
}
