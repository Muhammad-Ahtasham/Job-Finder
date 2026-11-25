'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACTIVE_RUN_STATUSES } from '@jobfinder/contracts';
import { AuthedPage } from '@/components/app-shell';
import { RunStatusBadge } from '@/components/badges';
import { CompaniesTable } from '@/components/companies-table';
import { JobsTable } from '@/components/jobs-table';
import { MatchingPreferences } from '@/components/matching-preferences';
import { RunProgress } from '@/components/run-progress';
import { EmptyState, ErrorState, PageHeader } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  cancelRun,
  deleteProject,
  getProject,
  getRunProgress,
  listRuns,
  startRun,
} from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useUrlState } from '@/lib/use-url-state';

function Config({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
  });
  if (project.isPending) return <Skeleton className="h-40 w-full" />;
  if (project.error) {
    return (
      <Card>
        <ErrorState error={project.error} onRetry={() => void project.refetch()} />
      </Card>
    );
  }
  const p = project.data;
  const list = (items: string[]) =>
    items.length === 0 ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      <span className="flex flex-wrap gap-1.5">
        {items.map((i) => (
          <Badge key={i} variant="secondary">
            {i}
          </Badge>
        ))}
      </span>
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">Industry</dt>
          <dd>{p.industry}</dd>
          <dt className="text-muted-foreground">Location</dt>
          <dd>
            {p.city}, {p.country}
          </dd>
          <dt className="text-muted-foreground">Keywords</dt>
          <dd>{list(p.keywords)}</dd>
          <dt className="text-muted-foreground">Target roles</dt>
          <dd>{list(p.targetRoles)}</dd>
          <dt className="text-muted-foreground">Target skills</dt>
          <dd>{list(p.targetSkills)}</dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>{formatDateTime(p.createdAt)}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}

function Runs({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ['runs', projectId],
    queryFn: () => listRuns(projectId),
    refetchInterval: 5000,
  });
  const runId = selected ?? runs.data?.items[0]?.id ?? null;
  const runStatus = runs.data?.items.find((r) => r.id === runId)?.status;
  const active = runStatus ? ACTIVE_RUN_STATUSES.includes(runStatus) : false;

  // Poll while the run is active; the progress is persisted server-side, so a reload loses nothing.
  const progress = useQuery({
    queryKey: ['progress', runId],
    queryFn: () => getRunProgress(runId!),
    enabled: Boolean(runId),
    refetchInterval: active ? 2000 : false,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['runs', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['progress'] });
    void queryClient.invalidateQueries({ queryKey: ['companies'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const start = useMutation({
    mutationFn: () => startRun(projectId),
    onSuccess: (run) => {
      setError(null);
      setSelected(run.id);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const cancel = useMutation({
    mutationFn: () => cancelRun(runId!),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });

  // Companies appear while a run is going and when it ends: refetch the tables as it advances.
  const status = progress.data?.status;
  const found = progress.data?.stats.candidatesFound;
  useEffect(() => {
    if (runId) void queryClient.invalidateQueries({ queryKey: ['companies'] });
  }, [runId, status, found, queryClient]);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle>Discovery runs</CardTitle>
          <CardDescription>
            Start a run to search for companies; progress is saved and survives a reload.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          {active && (
            <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              Cancel run
            </Button>
          )}
          <Button onClick={() => start.mutate()} disabled={start.isPending || active}>
            {active ? 'Run in progress…' : 'Start discovery'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {error && (
          <p role="alert" className="text-sm whitespace-pre-line text-destructive">
            {error}
          </p>
        )}
        {runs.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : runs.error ? (
          <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
        ) : runs.data.items.length === 0 ? (
          <EmptyState
            title="No runs yet"
            description="Start discovery to find companies matching this project."
          />
        ) : (
          <>
            <ul className="flex flex-wrap gap-2" aria-label="Runs">
              {runs.data.items.slice(0, 10).map((run, index) => (
                <li key={run.id}>
                  <Button
                    size="sm"
                    variant={run.id === runId ? 'default' : 'outline'}
                    onClick={() => setSelected(run.id)}
                    aria-pressed={run.id === runId}
                    title={formatDateTime(run.createdAt)}
                  >
                    #{runs.data.items.length - index} ·{' '}
                    {run.status.toLowerCase().replace(/_/g, ' ')}
                  </Button>
                </li>
              ))}
            </ul>
            {progress.isPending ? (
              <Skeleton className="h-32 w-full" />
            ) : progress.error ? (
              <ErrorState error={progress.error} onRetry={() => void progress.refetch()} />
            ) : (
              <RunProgress progress={progress.data} />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ProjectView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { state, update } = useUrlState({ tab: 'overview' });
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
  });
  const runs = useQuery({
    queryKey: ['runs', projectId],
    queryFn: () => listRuns(projectId),
    refetchInterval: 5000,
  });
  const active = runs.data?.items.some((r) => ACTIVE_RUN_STATUSES.includes(r.status)) ?? false;

  const remove = useMutation({
    mutationFn: () => deleteProject(projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      router.replace('/projects');
    },
    onError: (e: Error) => setError(e.message),
  });

  if (project.error) {
    return (
      <Card>
        <ErrorState error={project.error} onRetry={() => void project.refetch()} />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/projects" className="text-sm text-muted-foreground hover:text-foreground">
          ← Search projects
        </Link>
      </div>
      <PageHeader
        title={project.data?.name ?? 'Project'}
        description={
          project.data
            ? `${project.data.industry} · ${project.data.city}, ${project.data.country}`
            : undefined
        }
        actions={
          <>
            {runs.data?.items[0] && <RunStatusBadge status={runs.data.items[0].status} />}
            <Button
              variant="ghost"
              className="text-destructive"
              disabled={active || remove.isPending}
              onClick={() => {
                if (
                  window.confirm('Delete this project and its runs? Discovered companies are kept.')
                )
                  remove.mutate();
              }}
            >
              Delete project
            </Button>
          </>
        }
      />
      {error && (
        <p role="alert" className="text-sm whitespace-pre-line text-destructive">
          {error}
        </p>
      )}

      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <TabsList aria-label="Project sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="companies">Discovered companies</TabsTrigger>
          <TabsTrigger value="jobs">Matching jobs</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="flex flex-col gap-6">
          <Config projectId={projectId} />
          <Runs projectId={projectId} />
        </TabsContent>
        <TabsContent value="companies">
          <CompaniesTable projectId={projectId} prefix="c_" />
        </TabsContent>
        <TabsContent value="jobs" className="flex flex-col gap-6">
          <JobsTable projectId={projectId} prefix="j_" />
          <MatchingPreferences projectId={projectId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  return <AuthedPage>{() => <ProjectView projectId={id} />}</AuthedPage>;
}
