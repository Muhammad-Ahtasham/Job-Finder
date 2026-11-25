'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { AuthedPage } from '@/components/app-shell';
import { JobStatusBadge } from '@/components/badges';
import { QueryBoundary } from '@/components/query-boundary';
import { EmptyState, PageHeader } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getJob, getJobHistory } from '@/lib/api';
import { formatDate, formatDateTime, formatExperience, humanize, safeHref } from '@/lib/format';
import { cn } from '@/lib/utils';

const money = (n: number | null) => (n === null ? null : n.toLocaleString('en'));

function JobView({ id }: { id: string }) {
  const job = useQuery({ queryKey: ['job', id], queryFn: () => getJob(id) });
  const history = useQuery({ queryKey: ['job-history', id], queryFn: () => getJobHistory(id) });

  return (
    <div className="flex flex-col gap-6">
      <Link href="/jobs" className="text-sm text-muted-foreground hover:text-foreground">
        ← Job opportunities
      </Link>
      <QueryBoundary query={job} height="h-64">
        {(j) => {
          const apply = safeHref(j.applicationUrl);
          const posting = safeHref(j.sourceUrl);
          const salaryParts = j.salary
            ? [money(j.salary.min), money(j.salary.max)].filter(Boolean).join(' – ')
            : null;
          return (
            <>
              <PageHeader
                title={j.title}
                description={`${j.companyName}${j.location ? ` · ${j.location}` : ''}`}
                actions={
                  <>
                    <JobStatusBadge status={j.status} />
                    {(apply ?? posting) && (
                      <a
                        href={(apply ?? posting)!}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className={cn(buttonVariants())}
                      >
                        {apply ? 'Apply' : 'View posting'}
                        <ExternalLink className="size-4" aria-hidden="true" />
                        <span className="sr-only">(opens in a new tab)</span>
                      </a>
                    )}
                  </>
                }
              />

              <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
                <div className="flex min-w-0 flex-col gap-6">
                  <Card>
                    <CardHeader>
                      <CardTitle>Description</CardTitle>
                      <CardDescription>
                        Plain text as published by {j.providerId}.{' '}
                        {posting && (
                          <a
                            href={posting}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            className="text-primary hover:underline"
                          >
                            Original posting
                          </a>
                        )}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {j.description ? (
                        <p className="max-h-[32rem] overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">
                          {j.description}
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          The source did not publish a description.
                        </p>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>History</CardTitle>
                      <CardDescription>
                        Every check that saw this job, changes and status changes — newest first.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <QueryBoundary query={history} height="h-24">
                        {(h) =>
                          h.items.length === 0 ? (
                            <EmptyState title="No history yet" className="py-6" />
                          ) : (
                            <ol className="flex flex-col gap-3 text-sm">
                              {h.items.map((o) => (
                                <li
                                  key={o.id}
                                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-l-2 pl-3"
                                >
                                  <Badge
                                    variant={o.kind === 'STATUS_CHANGED' ? 'warning' : 'secondary'}
                                  >
                                    {humanize(o.kind)}
                                  </Badge>
                                  {o.kind === 'STATUS_CHANGED' && (
                                    <span>
                                      {o.fromStatus ? humanize(o.fromStatus) : '—'} →{' '}
                                      {o.toStatus ? humanize(o.toStatus) : '—'}
                                    </span>
                                  )}
                                  {o.kind === 'CHANGED' && (
                                    <span>{Object.keys(o.changes).map(humanize).join(', ')}</span>
                                  )}
                                  {o.reason && (
                                    <span className="text-muted-foreground">{o.reason}</span>
                                  )}
                                  <time
                                    className="ml-auto text-xs text-muted-foreground"
                                    dateTime={o.observedAt}
                                  >
                                    {formatDateTime(o.observedAt)}
                                  </time>
                                </li>
                              ))}
                            </ol>
                          )
                        }
                      </QueryBoundary>
                    </CardContent>
                  </Card>
                </div>

                <div className="flex flex-col gap-6">
                  <Card>
                    <CardHeader>
                      <CardTitle>Details</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
                        <dt className="text-muted-foreground">Company</dt>
                        <dd>
                          <Link
                            href={`/companies/${j.companyId}`}
                            className="text-primary hover:underline"
                          >
                            {j.companyName}
                          </Link>
                        </dd>
                        <dt className="text-muted-foreground">Role</dt>
                        <dd>
                          {j.normalizedTitle ?? '—'}
                          {j.roleCategory ? ` · ${humanize(j.roleCategory)}` : ''}
                        </dd>
                        <dt className="text-muted-foreground">Seniority</dt>
                        <dd>{j.seniority === 'UNKNOWN' ? 'Not stated' : humanize(j.seniority)}</dd>
                        <dt className="text-muted-foreground">Type</dt>
                        <dd>
                          {humanize(j.employmentType)} · {humanize(j.workplaceType)}
                        </dd>
                        <dt className="text-muted-foreground">Experience</dt>
                        <dd>{formatExperience(j.minYearsExperience, j.maxYearsExperience)}</dd>
                        <dt className="text-muted-foreground">Salary</dt>
                        <dd>
                          {j.salary && salaryParts
                            ? `${j.salary.currency ?? ''} ${salaryParts}${j.salary.period ? ` / ${j.salary.period.toLowerCase()}` : ''}`.trim()
                            : 'Not published'}
                        </dd>
                        <dt className="text-muted-foreground">Published</dt>
                        <dd>{formatDate(j.publishedAt)}</dd>
                        <dt className="text-muted-foreground">First seen</dt>
                        <dd>{formatDate(j.firstSeenAt)}</dd>
                        <dt className="text-muted-foreground">Last seen</dt>
                        <dd>{formatDate(j.lastSeenAt)}</dd>
                        {j.statusReason && (
                          <>
                            <dt className="text-muted-foreground">Status</dt>
                            <dd>{j.statusReason}</dd>
                          </>
                        )}
                      </dl>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Skills</CardTitle>
                      <CardDescription>
                        {j.analysis.state === 'ANALYZED'
                          ? `Read from the posting (${j.analysis.provider ?? 'rules'}).`
                          : 'Analysis pending.'}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {j.skills.length === 0 ? (
                        <p className="text-sm text-muted-foreground">None identified.</p>
                      ) : (
                        <ul className="flex flex-col gap-2 text-sm">
                          {j.skills.map((s) => (
                            <li key={s.key}>
                              <Badge variant={s.kind === 'REQUIRED' ? 'secondary' : 'outline'}>
                                {s.name}
                              </Badge>{' '}
                              <span className="text-xs text-muted-foreground">
                                {humanize(s.kind)}
                              </span>
                              {s.evidence && (
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  “{s.evidence}”
                                </p>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>

                  {j.requirements.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Requirements</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="flex flex-col gap-2 text-sm">
                          {j.requirements.map((r, i) => (
                            <li key={i}>
                              <Badge variant="outline">
                                {humanize(r.kind)}
                                {r.level ? ` · ${humanize(r.level)}` : ''}
                              </Badge>{' '}
                              <span className="text-xs text-muted-foreground">
                                {r.mandatory ? 'Required' : 'Preferred'}
                              </span>
                              <p className="mt-0.5 text-xs">“{r.text}”</p>
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  )}
                </div>
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </div>
  );
}

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  return <AuthedPage>{() => <JobView id={id} />}</AuthedPage>;
}
