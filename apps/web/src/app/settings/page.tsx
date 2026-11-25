'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AuthedPage, useActiveWorkspace } from '@/components/app-shell';
import { PageHeader } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { logout } from '@/lib/api';
import { setActiveWorkspaceId } from '@/lib/workspace';
import type { MeResponse } from '@jobfinder/contracts';

function Settings({ me }: { me: MeResponse }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const active = useActiveWorkspace(me);
  const signOut = useMutation({
    mutationFn: logout,
    onSettled: () => {
      queryClient.clear();
      router.replace('/login');
    },
  });

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="Settings" />

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>The person signed in.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{me.user.name}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{me.user.email}</dd>
          </dl>
          <Button
            variant="outline"
            className="self-start"
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
          >
            Sign out
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspaces</CardTitle>
          <CardDescription>
            Projects, companies, jobs and exports belong to a workspace. Only its members can see
            them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y" data-testid="workspace-list">
            {me.workspaces.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span className="min-w-40 flex-1 font-medium">
                  {w.name}
                  {w.isPersonal && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">personal</span>
                  )}
                </span>
                <Badge variant="secondary">{w.role}</Badge>
                {w.id === active.id ? (
                  <Badge variant="success">Active</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setActiveWorkspaceId(w.id);
                      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
                      router.push('/dashboard');
                    }}
                  >
                    Switch to this workspace
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Data handling</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>
            A “verified” email or website means it was published on the company’s verified website;
            it never means the mailbox exists.
          </p>
          <p>
            Job match scores are calculated from the project’s target roles, skills and matching
            preferences, which you can edit in each project.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  return <AuthedPage>{(me) => <Settings me={me} />}</AuthedPage>;
}
