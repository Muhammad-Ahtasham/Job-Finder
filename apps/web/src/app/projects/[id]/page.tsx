'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACTIVE_RUN_STATUSES, type RunProgress } from '@jobfinder/contracts';
import { AuthedPage } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  cancelRun,
  deleteProject,
  getProject,
  getRunProgress,
  getRunResults,
  listRuns,
  startRun,
} from '@/lib/api';

const runVariant = (status: string) =>
  status === 'COMPLETED'
    ? 'success'
    : status === 'COMPLETED_WITH_ERRORS'
      ? 'warning'
      : status === 'FAILED'
        ? 'destructive'
        : 'secondary';

const fieldVariant = (status: string) => (status === 'MISSING' ? 'outline' : 'secondary');

function Progress({ progress }: { progress: RunProgress }) {
  const t = progress.tasks;
  return (
    <div className="flex flex-col gap-4" data-testid="run-progress">
      <div className="flex items-center gap-3">
        <Badge variant={runVariant(progress.status)}>{progress.status}</Badge>
        {progress.cancelRequested && progress.status === 'RUNNING' && (
          <span className="text-xs text-muted-foreground">cancelling…</span>
        )}
        <div className="h-2 flex-1 overflow-hidden rounded bg-secondary">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
        <span className="text-sm tabular-nums">{progress.percent}%</span>
      </div>

      {progress.error && <p className="text-sm text-destructive">{progress.error}</p>}
      {progress.skippedProviders.length > 0 && (
        <ul className="text-xs text-muted-foreground">
          {progress.skippedProviders.map((p) => (
            <li key={p.id}>
              Provider <code>{p.id}</code> not used: {p.reason}
            </li>
          ))}
        </ul>
      )}

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {[
          ['Found', progress.stats.candidatesFound],
          ['New companies', progress.stats.companiesCreated],
          ['Matched existing', progress.stats.companiesMatched],
          ['Need review', progress.stats.reviewsCreated],
        ].map(([label, value]) => (
          <div key={label as string}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="text-xs text-muted-foreground">
        Tasks: {t.succeeded} done · {t.running} running · {t.queued} queued · {t.retrying} retrying
        · {t.failed} failed · {t.cancelled} cancelled · {progress.stats.duplicatesSkipped}{' '}
        duplicates skipped · {progress.stats.candidatesFiltered} non-company results filtered
      </p>

      {progress.providers.map((provider) => (
        <div key={provider.providerId} className="rounded-md border p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium">{provider.displayName}</span>
            <span className="text-muted-foreground">
              {provider.tasks.succeeded}/{provider.tasks.total} tasks · {provider.candidatesFound}{' '}
              found
            </span>
          </div>
          {provider.attribution && (
            <p className="text-xs text-muted-foreground">{provider.attribution}</p>
          )}
          {provider.errors.map((error) => (
            <p key={error.taskId} className="mt-1 text-xs text-destructive">
              {error.keyword ?? 'area search'}: {error.code} (
              {error.retryable ? 'retrying' : 'failed'}, attempt {error.attempts}) — {error.message}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

function ProjectView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
  });
  const runs = useQuery({
    queryKey: ['runs', projectId],
    queryFn: () => listRuns(projectId),
    refetchInterval: 5000,
  });

  const runId = selectedRunId ?? runs.data?.items[0]?.id ?? null;
  const runStatus = runs.data?.items.find((r) => r.id === runId)?.status;
  const active = runStatus ? ACTIVE_RUN_STATUSES.includes(runStatus) : false;

  // Poll progress while the run is active; results refresh alongside it.
  const progress = useQuery({
    queryKey: ['progress', runId],
    queryFn: () => getRunProgress(runId!),
    enabled: Boolean(runId),
    refetchInterval: active ? 2000 : false,
  });
  const results = useQuery({
    queryKey: ['results', runId, progress.data?.stats.candidatesFound, progress.data?.status],
    queryFn: () => getRunResults(runId!),
    enabled: Boolean(runId),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['runs', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['progress'] });
  };
  const start = useMutation({
    mutationFn: () => startRun(projectId),
    onSuccess: (run) => {
      setError(null);
      setSelectedRunId(run.id);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const cancel = useMutation({
    mutationFn: () => cancelRun(runId!),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });
  const remove = useMutation({
    mutationFn: () => deleteProject(projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      router.replace('/projects');
    },
    onError: (e: Error) => setError(e.message),
  });

  if (project.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (project.error) return <p className="text-sm text-destructive">{project.error.message}</p>;
  const p = project.data;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/projects" className="text-sm text-muted-foreground hover:text-foreground">
          ← Projects
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{p.name}</h1>
        <p className="text-sm text-muted-foreground">
          {p.industry} · {p.city}, {p.country}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {p.keywords.map((k) => (
            <Badge key={k} variant="secondary">
              {k}
            </Badge>
          ))}
        </div>
        {(p.targetRoles.length > 0 || p.targetSkills.length > 0) && (
          <p className="mt-2 text-xs text-muted-foreground">
            Roles: {p.targetRoles.join(', ') || '—'} · Skills: {p.targetSkills.join(', ') || '—'}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => start.mutate()} disabled={start.isPending || active}>
          {active ? 'Run in progress…' : 'Start discovery run'}
        </Button>
        {active && (
          <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            Cancel run
          </Button>
        )}
        <Button
          variant="ghost"
          className="ml-auto text-destructive"
          disabled={active || remove.isPending}
          onClick={() => {
            if (window.confirm('Delete this project and its runs? Discovered companies are kept.'))
              remove.mutate();
          }}
        >
          Delete project
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm whitespace-pre-line text-destructive">
          {error}
        </p>
      )}

      {runs.data && runs.data.items.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Runs:</span>
          {runs.data.items.slice(0, 8).map((run, index) => (
            <Button
              key={run.id}
              size="sm"
              variant={run.id === runId ? 'default' : 'outline'}
              onClick={() => setSelectedRunId(run.id)}
            >
              #{runs.data.items.length - index} {run.status.toLowerCase().replace(/_/g, ' ')}
            </Button>
          ))}
        </div>
      )}

      {progress.data && (
        <Card>
          <CardHeader>
            <CardTitle>Run progress</CardTitle>
            <CardDescription>
              Persisted in PostgreSQL; updates every 2 s while the run is active.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Progress progress={progress.data} />
          </CardContent>
        </Card>
      )}

      {results.data && (
        <Card>
          <CardHeader>
            <CardTitle>Companies found ({results.data.items.length})</CardTitle>
            <CardDescription>
              Incomplete companies are kept — a missing website, email or careers page is shown as a
              status, not a reason to drop them.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="results-table">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Company</th>
                  <th className="py-2 pr-4 font-medium">Website</th>
                  <th className="py-2 pr-4 font-medium">Outcome</th>
                  <th className="py-2 pr-4 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {results.data.items.map((item) => (
                  <tr key={item.id} className="border-t align-top">
                    <td className="py-2 pr-4 font-medium">{item.company.displayName}</td>
                    <td className="py-2 pr-4">
                      {item.company.website ? (
                        <span className="flex items-center gap-2">
                          {item.company.website.replace(/^https?:\/\//, '')}
                          <Badge variant={fieldVariant(item.company.websiteStatus)}>
                            {item.company.websiteStatus.toLowerCase()}
                          </Badge>
                        </span>
                      ) : (
                        <Badge variant="outline">missing</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge
                        variant={
                          item.outcome === 'CREATED'
                            ? 'success'
                            : item.outcome === 'MATCHED'
                              ? 'secondary'
                              : 'warning'
                        }
                      >
                        {item.outcome === 'REVIEW_REQUIRED'
                          ? 'needs review'
                          : item.outcome.toLowerCase()}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">{item.providerId}</td>
                  </tr>
                ))}
                {results.data.items.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-muted-foreground">
                      {active
                        ? 'Searching…'
                        : runId
                          ? 'No companies found for this run.'
                          : 'Start a run to discover companies.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  return <AuthedPage>{() => <ProjectView projectId={id} />}</AuthedPage>;
}
