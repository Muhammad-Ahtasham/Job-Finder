'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { ACTIVE_EXPORT_STATUSES, type Export } from '@jobfinder/contracts';
import { AuthedPage } from '@/components/app-shell';
import { FilterField, OptionSelect, TriSelect } from '@/components/filters';
import { EmptyState, ErrorState, PageHeader } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  createExport,
  getExportDownloadLink,
  getFacets,
  listExports,
  listProjects,
} from '@/lib/api';
import { formatDateTime, humanize, timeAgo } from '@/lib/format';

type Kind = 'COMPANIES' | 'JOBS';
type Scope = 'ALL' | 'FILTERED' | 'PROJECT';

const triToBool = (v: string) => (v === '' ? undefined : v === 'true');

function formatBytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function scopeText(e: Export): string {
  if (e.scope === 'PROJECT') return `Project: ${e.projectName ?? 'deleted project'}`;
  if (e.scope === 'FILTERED') {
    const parts = Object.entries(e.filters).map(
      ([k, v]) => `${humanize(k.replace(/([A-Z])/g, '_$1'))}: ${String(v)}`,
    );
    return parts.length ? parts.join(', ') : 'Filtered';
  }
  return 'Everything';
}

// ------------------------------------------------------------------ the request form

function NewExport({ onCreated }: { onCreated: () => void }) {
  const facets = useQuery({ queryKey: ['facets'], queryFn: getFacets, staleTime: 60_000 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects });

  const [kind, setKind] = useState<Kind>('COMPANIES');
  const [format, setFormat] = useState<'CSV' | 'XLSX'>('XLSX');
  const [scope, setScope] = useState<Scope>('ALL');
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState<string | null>(null);

  // company filters
  const [city, setCity] = useState('');
  const [industry, setIndustry] = useState('');
  const [q, setQ] = useState('');
  const [hasHrEmail, setHasHrEmail] = useState('');
  const [hasCareersPage, setHasCareersPage] = useState('');
  const [hiring, setHiring] = useState('');
  // job filters
  const [status, setStatus] = useState('OPEN');
  const [role, setRole] = useState('');
  const [skill, setSkill] = useState('');
  const [minScore, setMinScore] = useState('');

  const create = useMutation({
    mutationFn: createExport,
    onSuccess: () => {
      setError(null);
      onCreated();
    },
    onError: (e: Error) => setError(e.message),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (scope === 'PROJECT' && !projectId) {
      setError('Choose a project.');
      return;
    }
    const score = minScore === '' ? undefined : Number(minScore);
    if (score !== undefined && (!Number.isFinite(score) || score < 0 || score > 100)) {
      setError('Minimum match score must be a number from 0 to 100.');
      return;
    }
    const clean = <T extends Record<string, unknown>>(o: T) =>
      Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));

    let filters: Record<string, unknown> = {};
    if (scope !== 'ALL') {
      filters =
        kind === 'COMPANIES'
          ? clean({
              q: q.trim(),
              city,
              industry,
              hasHrEmail: triToBool(hasHrEmail),
              hasCareersPage: triToBool(hasCareersPage),
              hiring: triToBool(hiring),
            })
          : clean({
              q: q.trim(),
              city,
              industry,
              role,
              skill: skill.trim(),
              status: status || undefined,
              minMatchScore: scope === 'PROJECT' ? score : undefined,
            });
    }
    if (scope === 'FILTERED' && Object.keys(filters).length === 0) {
      setError('Pick at least one filter, or export everything.');
      return;
    }
    create.mutate({ type: kind, format, ...(scope === 'PROJECT' ? { projectId } : {}), filters });
  };

  const cities = (facets.data?.cities ?? []).map((c) => ({ value: c, label: c }));
  const industries = (facets.data?.industries ?? []).map((c) => ({ value: c, label: c }));

  return (
    <Card>
      <form onSubmit={submit} noValidate aria-label="New export">
        <CardHeader>
          <CardTitle>New export</CardTitle>
          <CardDescription>
            The file is built in the background; follow it in the history below.
          </CardDescription>
        </CardHeader>
        <CardContent className="mt-6 flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <FilterField label="What to export" htmlFor="x-kind">
              <Select id="x-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="COMPANIES">Companies</option>
                <option value="JOBS">Jobs</option>
              </Select>
            </FilterField>
            <FilterField label="Format" htmlFor="x-format">
              <Select
                id="x-format"
                value={format}
                onChange={(e) => setFormat(e.target.value as 'CSV' | 'XLSX')}
              >
                <option value="XLSX">Excel (.xlsx)</option>
                <option value="CSV">CSV (.csv)</option>
              </Select>
            </FilterField>
            <FilterField label="Scope" htmlFor="x-scope">
              <Select
                id="x-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as Scope)}
              >
                <option value="ALL">{kind === 'COMPANIES' ? 'All companies' : 'All jobs'}</option>
                <option value="FILTERED">
                  {kind === 'COMPANIES' ? 'Filtered companies' : 'Filtered jobs'}
                </option>
                <option value="PROJECT">
                  {kind === 'COMPANIES' ? 'A project’s companies' : 'A project’s job matches'}
                </option>
              </Select>
            </FilterField>
          </div>

          {scope === 'PROJECT' && (
            <div className="max-w-sm">
              <FilterField label="Project" htmlFor="x-project">
                <OptionSelect
                  id="x-project"
                  value={projectId}
                  onChange={setProjectId}
                  anyLabel="Choose a project…"
                  options={(projects.data?.items ?? []).map((p) => ({
                    value: p.id,
                    label: p.name,
                  }))}
                />
              </FilterField>
            </div>
          )}

          {scope !== 'ALL' && (
            <fieldset className="grid gap-4 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-4">
              <legend className="px-1 text-sm font-medium">
                {scope === 'PROJECT' ? 'Optional filters' : 'Filters'}
              </legend>
              <FilterField label="Search" htmlFor="x-q">
                <Input
                  id="x-q"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  maxLength={100}
                  placeholder={kind === 'COMPANIES' ? 'Name or domain' : 'Title or company'}
                />
              </FilterField>
              <FilterField label="City" htmlFor="x-city">
                <OptionSelect id="x-city" value={city} onChange={setCity} options={cities} />
              </FilterField>
              <FilterField label="Industry" htmlFor="x-industry">
                <OptionSelect
                  id="x-industry"
                  value={industry}
                  onChange={setIndustry}
                  options={industries}
                />
              </FilterField>
              {kind === 'COMPANIES' ? (
                <>
                  <FilterField label="Has HR email" htmlFor="x-hr">
                    <TriSelect id="x-hr" value={hasHrEmail} onChange={setHasHrEmail} />
                  </FilterField>
                  <FilterField label="Has careers page" htmlFor="x-careers">
                    <TriSelect id="x-careers" value={hasCareersPage} onChange={setHasCareersPage} />
                  </FilterField>
                  <FilterField label="Currently hiring" htmlFor="x-hiring">
                    <TriSelect id="x-hiring" value={hiring} onChange={setHiring} />
                  </FilterField>
                </>
              ) : (
                <>
                  <FilterField label="Job status" htmlFor="x-status">
                    <OptionSelect
                      id="x-status"
                      value={status}
                      onChange={setStatus}
                      anyLabel="Any status"
                      options={['OPEN', 'CLOSED', 'EXPIRED', 'UNKNOWN'].map((s) => ({
                        value: s,
                        label: humanize(s),
                      }))}
                    />
                  </FilterField>
                  <FilterField label="Job role" htmlFor="x-role">
                    <OptionSelect
                      id="x-role"
                      value={role}
                      onChange={setRole}
                      options={(facets.data?.roleCategories ?? []).map((r) => ({
                        value: r,
                        label: humanize(r),
                      }))}
                    />
                  </FilterField>
                  <FilterField label="Skill" htmlFor="x-skill">
                    <Input
                      id="x-skill"
                      value={skill}
                      onChange={(e) => setSkill(e.target.value)}
                      maxLength={60}
                      placeholder="e.g. Node.js"
                    />
                  </FilterField>
                  {scope === 'PROJECT' && (
                    <FilterField label="Minimum match score" htmlFor="x-score">
                      <Input
                        id="x-score"
                        type="number"
                        min={0}
                        max={100}
                        value={minScore}
                        onChange={(e) => setMinScore(e.target.value)}
                        placeholder="0–100"
                      />
                    </FilterField>
                  )}
                </>
              )}
            </fieldset>
          )}

          {error && (
            <p role="alert" className="text-sm whitespace-pre-line text-destructive">
              {error}
            </p>
          )}
          <div>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Requesting…' : 'Create export'}
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------ history

const statusVariant = (s: string) =>
  s === 'COMPLETED'
    ? 'success'
    : s === 'FAILED'
      ? 'destructive'
      : s === 'EXPIRED'
        ? 'outline'
        : 'secondary';

function DownloadButton({ item }: { item: Export }) {
  const [error, setError] = useState<string | null>(null);
  const download = useMutation({
    mutationFn: () => getExportDownloadLink(item.id),
    // The link is valid for a few seconds only: use it immediately.
    onSuccess: (link) => {
      setError(null);
      window.location.assign(link.url);
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant="outline"
        onClick={() => download.mutate()}
        disabled={download.isPending}
      >
        <Download className="size-3.5" aria-hidden="true" />
        Download
        <span className="sr-only"> {item.fileName}</span>
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

function History() {
  const history = useQuery({
    queryKey: ['exports'],
    queryFn: () => listExports({ limit: 50 }),
    // Poll while anything is in progress.
    refetchInterval: (query) =>
      query.state.data?.items.some((e) => ACTIVE_EXPORT_STATUSES.includes(e.status)) ? 2000 : false,
  });

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="py-4">
        <CardTitle>Export history</CardTitle>
        <CardDescription>
          Files are kept for a limited time, then deleted; the entry stays.
        </CardDescription>
      </CardHeader>
      {history.isPending ? (
        <div className="flex flex-col gap-3 border-t p-4" aria-busy="true">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : history.error ? (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} />
      ) : history.data.items.length === 0 ? (
        <EmptyState title="No exports yet" description="Create one above; it will appear here." />
      ) : (
        <Table aria-label="Export history">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Export</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Requested</TableHead>
              <TableHead>File</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.data.items.map((e) => (
              <TableRow key={e.id} className="align-top">
                <TableCell>
                  <span className="flex items-center gap-2 font-medium">
                    {e.format === 'XLSX' ? (
                      <FileSpreadsheet className="size-4" aria-hidden="true" />
                    ) : (
                      <FileText className="size-4" aria-hidden="true" />
                    )}
                    {humanize(e.type)} · {e.format}
                  </span>
                </TableCell>
                <TableCell className="max-w-56 whitespace-normal text-xs text-muted-foreground">
                  {scopeText(e)}
                </TableCell>
                <TableCell className="min-w-40 whitespace-normal">
                  <Badge variant={statusVariant(e.status)}>{humanize(e.status)}</Badge>
                  {ACTIVE_EXPORT_STATUSES.includes(e.status) && (
                    <div className="mt-2 flex items-center gap-2">
                      <div
                        className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary"
                        role="progressbar"
                        aria-label="Export progress"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={e.progress.percent}
                      >
                        <div
                          className="h-full bg-primary transition-all"
                          style={{ width: `${e.progress.percent}%` }}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {e.progress.rowsTotal === null
                          ? 'Starting…'
                          : `${e.progress.rowsProcessed.toLocaleString('en')} / ${e.progress.rowsTotal.toLocaleString('en')}`}
                      </span>
                    </div>
                  )}
                  {e.status === 'FAILED' && e.errorMessage && (
                    <p role="alert" className="mt-1 text-xs text-destructive">
                      {e.errorMessage}
                    </p>
                  )}
                  {e.status === 'QUEUED' && e.errorCode === 'RETRYING' && (
                    <p className="mt-1 text-xs text-muted-foreground">Retrying after an error…</p>
                  )}
                </TableCell>
                <TableCell className="tabular-nums">
                  {e.rowCount?.toLocaleString('en') ?? '—'}
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatBytes(e.sizeBytes)}</TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  <time dateTime={e.createdAt} title={formatDateTime(e.createdAt)}>
                    {timeAgo(e.createdAt)}
                  </time>
                </TableCell>
                <TableCell>
                  {e.downloadable ? (
                    <DownloadButton item={e} />
                  ) : e.status === 'EXPIRED' ? (
                    <span className="text-xs text-muted-foreground">
                      Deleted {timeAgo(e.expiresAt)}
                    </span>
                  ) : e.status === 'COMPLETED' ? (
                    <span className="text-xs text-muted-foreground">Expired</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                  {e.downloadable && e.expiresAt && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Kept until {formatDateTime(e.expiresAt)}
                    </p>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function Exports() {
  const queryClient = useQueryClient();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Exports"
        description="Download companies and jobs as CSV or Excel. Exports run in the background and only your workspace can see them."
      />
      <NewExport onCreated={() => void queryClient.invalidateQueries({ queryKey: ['exports'] })} />
      <History />
      <p className="text-xs text-muted-foreground">
        Text that starts with = + - or @ is saved with a leading apostrophe so spreadsheets never
        run it as a formula. “Verified” means published on the company’s verified website, not that
        a mailbox exists.
      </p>
    </div>
  );
}

export default function ExportsPage() {
  return <AuthedPage>{() => <Exports />}</AuthedPage>;
}
