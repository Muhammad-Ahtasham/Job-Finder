'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchMe, logout } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function DashboardPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: me, isPending, isError } = useQuery({ queryKey: ['me'], queryFn: fetchMe });

  // The API is the authority; this redirect is only UX for an expired session.
  useEffect(() => {
    if (!isPending && !me && !isError) router.replace('/login');
  }, [isPending, me, isError, router]);

  const signOut = useMutation({
    mutationFn: logout,
    onSettled: () => {
      queryClient.clear();
      router.replace('/login');
    },
  });

  if (isError) {
    return (
      <main className="p-8 text-sm text-destructive">Could not reach the API. Is it running?</main>
    );
  }
  if (isPending || !me) {
    return <main className="p-8 text-sm text-muted-foreground">Loading…</main>;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as {me.user.name} ({me.user.email})
          </p>
        </div>
        <Button variant="outline" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
          Sign out
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Your workspaces</CardTitle>
          <CardDescription>
            Create a search project to start discovering companies.{' '}
            <a href="/projects" className="underline underline-offset-4">
              Go to projects
            </a>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2" data-testid="workspace-list">
            {me.workspaces.map((workspace) => (
              <li
                key={workspace.id}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <span>
                  {workspace.name}
                  {workspace.isPersonal && (
                    <span className="ml-2 text-xs text-muted-foreground">personal</span>
                  )}
                </span>
                <span className="rounded bg-secondary px-2 py-0.5 text-xs font-medium">
                  {workspace.role}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}
