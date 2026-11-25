'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { RunStatusBadge } from '@/components/badges';
import { AuthedPage } from '@/components/app-shell';
import { EmptyState, ErrorState, PageHeader, StatCard } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { getDashboardSummary } from '@/lib/api';
import { timeAgo } from '@/lib/format';

function Dashboard() {
  const summary = useQuery({
    queryKey: ['dashboard'],
    queryFn: getDashboardSummary,
    // Discovery runs change these numbers; keep them fresh while the page is open.
    refetchInterval: 15_000,
  });
  const s = summary.data;
  const loading = summary.isPending;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="Everything discovered in this workspace."
        actions={
          <Button asChild>
            <Link href="/projects">Search projects</Link>
          </Button>
        }
      />

      {summary.error ? (
        <Card>
          <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
        </Card>
      ) : (
        <>
          <section aria-label="Key figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <StatCard
              label="Companies discovered"
              value={s?.companies.total}
              loading={loading}
              href="/companies"
            />
            <StatCard
              label="Verified websites"
              value={s?.companies.verifiedWebsites}
              loading={loading}
              href="/companies?websiteStatus=VERIFIED"
            />
            <StatCard
              label="With a careers page"
              value={s?.companies.withCareersPage}
              loading={loading}
              href="/companies?hasCareersPage=true"
            />
            <StatCard
              label="With a published HR email"
              value={s?.companies.withHrEmail}
              loading={loading}
              href="/companies?hasHrEmail=true"
              hint="Published on the verified website; not a mailbox check."
            />
            <StatCard
              label="Currently hiring"
              value={s?.companies.hiring}
              loading={loading}
              href="/companies?hiring=true"
            />
            <StatCard
              label="Active job openings"
              value={s?.jobs.open}
              loading={loading}
              href="/jobs"
              hint={s ? `${s.jobs.matched.toLocaleString('en')} matched to a project` : undefined}
            />
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Recent discovery activity</CardTitle>
              <CardDescription>The latest runs across all search projects.</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex flex-col gap-3" aria-busy="true">
                  {Array.from({ length: 4 }, (_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : s && s.recentRuns.length > 0 ? (
                <ul className="divide-y" data-testid="recent-runs">
                  {s.recentRuns.map((run) => (
                    <li
                      key={run.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-sm"
                    >
                      <Link
                        href={`/projects/${run.projectId}`}
                        className="min-w-40 flex-1 font-medium hover:underline"
                      >
                        {run.projectName}
                      </Link>
                      <RunStatusBadge status={run.status} />
                      <span className="text-muted-foreground tabular-nums">
                        {run.candidatesFound} found · {run.companiesCreated} new ·{' '}
                        {run.companiesMatched} matched
                      </span>
                      <time
                        className="w-28 text-right text-xs text-muted-foreground"
                        dateTime={run.createdAt}
                      >
                        {timeAgo(run.finishedAt ?? run.createdAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  title="No discovery runs yet"
                  description="Create a search project and start a run to find companies."
                  action={
                    <Button asChild size="sm">
                      <Link href="/projects">Create a project</Link>
                    </Button>
                  }
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export default function DashboardPage() {
  return <AuthedPage>{() => <Dashboard />}</AuthedPage>;
}
