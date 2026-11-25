'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import type { CompanyReview } from '@jobfinder/contracts';
import { AuthedPage } from '@/components/app-shell';
import { FieldStatusBadge, RunStatusBadge } from '@/components/badges';
import { JobsTable } from '@/components/jobs-table';
import { QueryBoundary } from '@/components/query-boundary';
import { EmptyState, ErrorState, PageHeader } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  approveWebsiteReview,
  enrichCompany,
  getCompany,
  getCompanyContacts,
  getCompanyJobSources,
  getCompanySources,
  refreshCompanyJobs,
  rejectWebsiteReview,
} from '@/lib/api';
import { displayUrl, formatDateTime, humanize, safeHref, timeAgo } from '@/lib/format';
import { useUrlState } from '@/lib/use-url-state';

function Ext({ url, label }: { url: string | null | undefined; label?: string }) {
  const href = safeHref(url);
  if (!url) return <span className="text-muted-foreground">—</span>;
  if (!href) return <span className="break-all">{url}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="inline-flex max-w-full items-center gap-1 break-all text-primary hover:underline"
    >
      {label ?? displayUrl(href)}
      <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[11rem_1fr]">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const confidence = (n: number) => `${Math.round(n * 100)}%`;

// ------------------------------------------------------------------ tabs

function Overview({ id }: { id: string }) {
  const company = useQuery({ queryKey: ['company', id], queryFn: () => getCompany(id) });
  const sources = useQuery({
    queryKey: ['company-sources', id],
    queryFn: () => getCompanySources(id),
  });
  const jobSources = useQuery({
    queryKey: ['company-job-sources', id],
    queryFn: () => getCompanyJobSources(id),
  });
  return (
    <QueryBoundary query={company}>
      {(c) => (
        <Card>
          <CardHeader>
            <CardTitle>Overview</CardTitle>
            {c.description && <CardDescription>{c.description}</CardDescription>}
          </CardHeader>
          <CardContent>
            <Facts
              items={[
                [
                  'Website',
                  <span key="w" className="flex flex-wrap items-center gap-2">
                    <Ext url={c.website} />
                    <FieldStatusBadge status={c.websiteStatus} />
                  </span>,
                ],
                ['Published emails', <FieldStatusBadge key="e" status={c.emailStatus} />],
                ['Careers page', <FieldStatusBadge key="c" status={c.careersStatus} />],
                ['Location', [c.city, c.country].filter(Boolean).join(', ')],
                ['Also known as', c.aliases.length ? c.aliases.join(', ') : '—'],
                ['Discovered from', `${c.sourceCount} source${c.sourceCount === 1 ? '' : 's'}`],
                [
                  'Open jobs',
                  jobSources.data
                    ? String(jobSources.data.sources.reduce((n, s) => n + s.openJobs, 0))
                    : '…',
                ],
                ['Last enriched', sources.data ? timeAgo(sources.data.lastEnrichedAt) : '…'],
                ['Added', formatDateTime(c.createdAt)],
              ]}
            />
          </CardContent>
        </Card>
      )}
    </QueryBoundary>
  );
}

function Locations({ id }: { id: string }) {
  const company = useQuery({ queryKey: ['company', id], queryFn: () => getCompany(id) });
  return (
    <QueryBoundary query={company}>
      {(c) => (
        <Card className="gap-0 overflow-hidden py-0">
          {c.locations.length === 0 ? (
            <EmptyState
              title="No locations recorded"
              description="Discovery providers did not report an address for this company."
            />
          ) : (
            <Table aria-label="Locations">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>City</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Phones</TableHead>
                  <TableHead>Coordinates</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.locations.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell>{l.city ?? '—'}</TableCell>
                    <TableCell className="whitespace-normal">{l.address ?? '—'}</TableCell>
                    <TableCell>{l.phones.length ? l.phones.join(', ') : '—'}</TableCell>
                    <TableCell className="tabular-nums">
                      {l.lat !== null && l.lng !== null
                        ? `${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}`
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      )}
    </QueryBoundary>
  );
}

function Contacts({ id }: { id: string }) {
  const contacts = useQuery({
    queryKey: ['company-contacts', id],
    queryFn: () => getCompanyContacts(id),
  });
  return (
    <QueryBoundary query={contacts}>
      {(data) => (
        <Card className="gap-0 overflow-hidden py-0">
          {data.items.length === 0 ? (
            <EmptyState
              title="No contacts found"
              description="Nothing was published on the company’s verified website. Run enrichment to look again."
            />
          ) : (
            <Table aria-label="Contacts">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Contact</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>Found on</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((c) => (
                  <TableRow key={c.id} className="align-top">
                    <TableCell className="whitespace-normal">
                      {c.kind === 'EMAIL' ? (
                        <a
                          href={`mailto:${c.value}`}
                          className="break-all text-primary hover:underline"
                        >
                          {c.value}
                        </a>
                      ) : (
                        <Ext url={c.value} label="LinkedIn page" />
                      )}
                      {c.context && (
                        <p className="mt-1 max-w-md text-xs text-muted-foreground">“{c.context}”</p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {c.kind === 'EMAIL' ? humanize(c.category ?? 'OTHER') : 'LinkedIn'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <FieldStatusBadge status={c.verificationStatus} />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {humanize(c.verificationMethod)}
                      </p>
                    </TableCell>
                    <TableCell className="tabular-nums">{confidence(c.confidence)}</TableCell>
                    <TableCell className="whitespace-normal">
                      <Ext url={c.sourceUrl} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="border-t px-4 py-3 text-xs text-muted-foreground">
            “Verified” means the address is published on the company’s verified website. It does not
            mean the mailbox exists or is monitored.
          </p>
        </Card>
      )}
    </QueryBoundary>
  );
}

function Careers({ id }: { id: string }) {
  const sources = useQuery({
    queryKey: ['company-sources', id],
    queryFn: () => getCompanySources(id),
  });
  const jobSources = useQuery({
    queryKey: ['company-job-sources', id],
    queryFn: () => getCompanyJobSources(id),
  });
  return (
    <div className="flex flex-col gap-6">
      <QueryBoundary query={jobSources} height="h-48">
        {(js) => (
          <Card>
            <CardHeader>
              <CardTitle>Job sources</CardTitle>
              <CardDescription>
                {js.vacancyKnowledge === 'KNOWN'
                  ? 'At least one source has answered, so the job list below is trustworthy.'
                  : 'No source has answered successfully yet. An empty job list means “not known”, not “no vacancies”.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {js.sources.length === 0 ? (
                <EmptyState
                  title="No job sources found"
                  description="Refresh jobs to look for a careers page or job board."
                  className="py-6"
                />
              ) : (
                js.sources.map((s) => (
                  <div key={s.id} className="rounded-md border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{humanize(s.providerId)}</span>
                      <Badge variant={s.status === 'ACTIVE' ? 'success' : 'outline'}>
                        {humanize(s.status)}
                      </Badge>
                      {s.lastOutcome && (
                        <Badge variant="secondary">{humanize(s.lastOutcome)}</Badge>
                      )}
                      <span className="text-muted-foreground">
                        {s.openJobs} open job{s.openJobs === 1 ? '' : 's'}
                      </span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        checked {timeAgo(s.lastCheckedAt)}
                      </span>
                    </div>
                    <p className="mt-1">
                      <Ext url={s.boardUrl} />
                    </p>
                    {s.discoveryEvidence && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Found because: {s.discoveryEvidence}
                      </p>
                    )}
                    {s.latestChecks.length > 0 && (
                      <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                        {s.latestChecks.map((c) => (
                          <li key={c.id}>
                            {formatDateTime(c.startedAt)} — {humanize(c.outcome)}
                            {c.outcome === 'FAILED' && c.errorMessage ? ` (${c.errorMessage})` : ''}
                            {c.evidence ? ` — ${c.evidence}` : ''}
                            {c.outcome === 'JOBS'
                              ? ` · ${c.jobsFound} found, ${c.jobsCreated} new, ${c.jobsClosed} closed`
                              : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        )}
      </QueryBoundary>

      <QueryBoundary query={sources} height="h-32">
        {(src) => {
          const pages = src.pages.filter((p) => p.type === 'CAREERS' || p.type === 'JOBS');
          return (
            <Card className="gap-0 overflow-hidden py-0">
              <CardHeader className="py-4">
                <CardTitle>Careers pages</CardTitle>
              </CardHeader>
              {pages.length === 0 ? (
                <EmptyState title="No careers page found" className="py-6" />
              ) : (
                <ul className="divide-y border-t">
                  {pages.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-3 px-6 py-3 text-sm">
                      <span className="min-w-0 flex-1">
                        <Ext url={p.url} />
                      </span>
                      <Badge variant="secondary">
                        {humanize(p.type)} · {confidence(p.typeConfidence)}
                      </Badge>
                      {p.external && <Badge variant="outline">External job board</Badge>}
                      <Badge variant={p.fetchStatus === 'FETCHED' ? 'success' : 'outline'}>
                        {humanize(p.fetchStatus)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        }}
      </QueryBoundary>
    </div>
  );
}

function SourcesTab({ id }: { id: string }) {
  const company = useQuery({ queryKey: ['company', id], queryFn: () => getCompany(id) });
  const sources = useQuery({
    queryKey: ['company-sources', id],
    queryFn: () => getCompanySources(id),
  });
  return (
    <div className="flex flex-col gap-6">
      <QueryBoundary query={company}>
        {(c) => (
          <Card className="gap-0 overflow-hidden py-0">
            <CardHeader className="py-4">
              <CardTitle>Where this company came from</CardTitle>
              <CardDescription>
                Every provider that reported it, with its attribution.
              </CardDescription>
            </CardHeader>
            {c.sources.length === 0 ? (
              <EmptyState title="No sources" className="py-6" />
            ) : (
              <Table aria-label="Discovery sources">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Provider</TableHead>
                    <TableHead>Keyword</TableHead>
                    <TableHead>Source page</TableHead>
                    <TableHead>Retrieved</TableHead>
                    <TableHead>Attribution</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {c.sources.map((s, i) => (
                    <TableRow key={i} className="align-top">
                      <TableCell className="font-medium">{s.providerId}</TableCell>
                      <TableCell>{s.matchedKeyword ?? '—'}</TableCell>
                      <TableCell className="whitespace-normal">
                        <Ext url={s.sourceUrl} />
                      </TableCell>
                      <TableCell>{formatDateTime(s.retrievedAt)}</TableCell>
                      <TableCell className="whitespace-normal text-xs text-muted-foreground">
                        {s.attribution ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {c.identities.length > 0 && (
              <div className="border-t px-6 py-4 text-sm">
                <p className="mb-2 font-medium">Identifiers</p>
                <ul className="flex flex-wrap gap-2">
                  {c.identities.map((i) => (
                    <li key={`${i.type}:${i.scope}:${i.value}`}>
                      <Badge variant="outline">
                        {humanize(i.type)}: {i.value}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        )}
      </QueryBoundary>

      <QueryBoundary query={sources} height="h-32">
        {(src) => (
          <Card className="gap-0 overflow-hidden py-0">
            <CardHeader className="py-4">
              <CardTitle>Pages read on the website</CardTitle>
              <CardDescription>
                Evidence for contacts and careers links comes from these pages.
              </CardDescription>
            </CardHeader>
            {src.pages.length === 0 ? (
              <EmptyState
                title="No pages read yet"
                description="Run enrichment to crawl the verified website."
                className="py-6"
              />
            ) : (
              <ul className="divide-y border-t">
                {src.pages.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 px-6 py-2.5 text-sm">
                    <span className="min-w-0 flex-1">
                      <Ext url={p.url} />
                    </span>
                    <Badge variant="secondary">{humanize(p.type)}</Badge>
                    <Badge variant={p.fetchStatus === 'FETCHED' ? 'success' : 'outline'}>
                      {humanize(p.fetchStatus)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </QueryBoundary>
    </div>
  );
}

function ReviewCard({ review, companyId }: { review: CompanyReview; companyId: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['company-sources', companyId] });
    void queryClient.invalidateQueries({ queryKey: ['company', companyId] });
    void queryClient.invalidateQueries({ queryKey: ['companies'] });
  };
  const approve = useMutation({
    mutationFn: () => approveWebsiteReview(review.id),
    onSuccess: done,
    onError: (e: Error) => setError(e.message),
  });
  const reject = useMutation({
    mutationFn: () => rejectWebsiteReview(review.id),
    onSuccess: done,
    onError: (e: Error) => setError(e.message),
  });
  return (
    <div className="rounded-md border p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Ext url={review.subjectUrl} />
        <Badge
          variant={
            review.decision === 'OFFICIAL'
              ? 'success'
              : review.decision === 'REJECTED'
                ? 'destructive'
                : 'warning'
          }
        >
          {humanize(review.decision)}
        </Badge>
        <span className="text-muted-foreground">{confidence(review.confidence)} confidence</span>
        <Badge variant="outline">
          {humanize(review.status)}
          {review.decidedManually ? ' by a person' : ''}
        </Badge>
        <time className="ml-auto text-xs text-muted-foreground" dateTime={review.updatedAt}>
          {timeAgo(review.updatedAt)}
        </time>
      </div>
      {review.evidence.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-xs">
          {review.evidence.map((e, i) => (
            <li key={i} className="flex gap-2">
              <span
                className={`w-10 shrink-0 text-right tabular-nums ${e.weight < 0 ? 'text-destructive' : 'text-muted-foreground'}`}
              >
                {e.weight > 0 ? '+' : ''}
                {e.weight.toFixed(2)}
              </span>
              <span>
                <span className="font-medium">{humanize(e.signal)}:</span> {e.detail}
                {e.url && (
                  <>
                    {' '}
                    <Ext url={e.url} />
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {review.status !== 'APPROVED' && (
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            onClick={() => approve.mutate()}
            disabled={approve.isPending || reject.isPending}
          >
            Accept as official website
          </Button>
          {review.status !== 'REJECTED' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => reject.mutate()}
              disabled={approve.isPending || reject.isPending}
            >
              Reject
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function History({ id }: { id: string }) {
  const sources = useQuery({
    queryKey: ['company-sources', id],
    queryFn: () => getCompanySources(id),
  });
  const jobSources = useQuery({
    queryKey: ['company-job-sources', id],
    queryFn: () => getCompanyJobSources(id),
  });
  return (
    <div className="flex flex-col gap-6">
      <QueryBoundary query={sources} height="h-48">
        {(src) => (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Website decisions</CardTitle>
                <CardDescription>
                  Every website candidate that was evaluated, with the evidence behind the decision.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {src.candidates.length === 0 ? (
                  <EmptyState title="No website was evaluated" className="py-6" />
                ) : (
                  src.candidates.map((r) => <ReviewCard key={r.id} review={r} companyId={id} />)
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Enrichment runs</CardTitle>
              </CardHeader>
              <CardContent>
                {src.runs.length === 0 ? (
                  <EmptyState title="No enrichment runs yet" className="py-6" />
                ) : (
                  <ul className="divide-y">
                    {src.runs.map((r) => (
                      <li
                        key={r.id}
                        className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-sm"
                      >
                        <RunStatusBadge status={r.status} />
                        <span className="text-muted-foreground">
                          {r.pagesFound} pages · {r.contactsFound} contacts
                        </span>
                        {r.errorMessage && (
                          <span className="text-destructive">{r.errorMessage}</span>
                        )}
                        <time
                          className="ml-auto text-xs text-muted-foreground"
                          dateTime={r.createdAt}
                        >
                          {formatDateTime(r.createdAt)}
                        </time>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </QueryBoundary>

      <QueryBoundary query={jobSources} height="h-32">
        {(js) => (
          <Card>
            <CardHeader>
              <CardTitle>Job discovery runs</CardTitle>
            </CardHeader>
            <CardContent>
              {js.runs.length === 0 ? (
                <EmptyState title="No job runs yet" className="py-6" />
              ) : (
                <ul className="divide-y">
                  {js.runs.map((r) => (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-sm"
                    >
                      <RunStatusBadge status={r.status} />
                      <span className="text-muted-foreground">
                        {r.careerPagesFound} career pages · {r.sourcesChecked} sources ·{' '}
                        {r.jobsFound} jobs
                      </span>
                      {r.errors.slice(0, 2).map((e, i) => (
                        <span key={i} className="text-xs text-muted-foreground">
                          {e.message}
                        </span>
                      ))}
                      <time
                        className="ml-auto text-xs text-muted-foreground"
                        dateTime={r.createdAt}
                      >
                        {formatDateTime(r.createdAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
      </QueryBoundary>
    </div>
  );
}

// ------------------------------------------------------------------ page

function CompanyView({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const { state, update } = useUrlState({ tab: 'overview' });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const company = useQuery({ queryKey: ['company', id], queryFn: () => getCompany(id) });

  const enrich = useMutation({
    mutationFn: () => enrichCompany(id),
    onSuccess: (r) => {
      setNotice({
        ok: true,
        text: r.reused
          ? 'Enrichment is already running.'
          : 'Enrichment started. Contacts and pages appear here when it finishes.',
      });
      void queryClient.invalidateQueries({ queryKey: ['company-sources', id] });
    },
    onError: (e: Error) => setNotice({ ok: false, text: e.message }),
  });
  const jobs = useMutation({
    mutationFn: () => refreshCompanyJobs(id),
    onSuccess: (r) => {
      setNotice({
        ok: true,
        text: r.reused
          ? 'A job refresh is already running.'
          : 'Job refresh started. New jobs appear in the Jobs tab.',
      });
      void queryClient.invalidateQueries({ queryKey: ['company-job-sources', id] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (e: Error) => setNotice({ ok: false, text: e.message }),
  });

  if (company.error) {
    return (
      <Card>
        <ErrorState error={company.error} onRetry={() => void company.refetch()} />
      </Card>
    );
  }
  const c = company.data;

  return (
    <div className="flex flex-col gap-6">
      <Link href="/companies" className="text-sm text-muted-foreground hover:text-foreground">
        ← Companies
      </Link>
      {c ? (
        <PageHeader
          title={c.displayName}
          description={[c.city, c.country].filter(Boolean).join(', ')}
          actions={
            <>
              <Button variant="outline" onClick={() => enrich.mutate()} disabled={enrich.isPending}>
                {enrich.isPending ? 'Starting…' : 'Enrich website'}
              </Button>
              <Button onClick={() => jobs.mutate()} disabled={jobs.isPending}>
                {jobs.isPending ? 'Starting…' : 'Refresh jobs'}
              </Button>
            </>
          }
        />
      ) : (
        <Skeleton className="h-16 w-full" />
      )}
      {notice && (
        <p
          role={notice.ok ? 'status' : 'alert'}
          className={`text-sm ${notice.ok ? 'text-muted-foreground' : 'text-destructive'}`}
        >
          {notice.text}
        </p>
      )}

      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <TabsList aria-label="Company sections">
          {[
            ['overview', 'Overview'],
            ['locations', 'Locations'],
            ['contacts', 'Contacts'],
            ['careers', 'Careers'],
            ['jobs', 'Jobs'],
            ['sources', 'Sources'],
            ['history', 'Verification history'],
          ].map(([value, label]) => (
            <TabsTrigger key={value} value={value!}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <Overview id={id} />
        </TabsContent>
        <TabsContent value="locations">
          <Locations id={id} />
        </TabsContent>
        <TabsContent value="contacts">
          <Contacts id={id} />
        </TabsContent>
        <TabsContent value="careers">
          <Careers id={id} />
        </TabsContent>
        <TabsContent value="jobs">
          <JobsTable companyId={id} prefix="j_" />
        </TabsContent>
        <TabsContent value="sources">
          <SourcesTab id={id} />
        </TabsContent>
        <TabsContent value="history">
          <History id={id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function CompanyPage() {
  const { id } = useParams<{ id: string }>();
  return <AuthedPage>{() => <CompanyView id={id} />}</AuthedPage>;
}
