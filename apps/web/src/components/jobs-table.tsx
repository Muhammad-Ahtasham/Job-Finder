'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ExternalLink } from 'lucide-react';
import type { JobRow } from '@jobfinder/contracts';
import { JobStatusBadge, MatchScore } from '@/components/badges';
import { ServerTable } from '@/components/data-table';
import { FilterBar, FilterField, OptionSelect, SearchBox } from '@/components/filters';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getFacets, listJobDirectory, listProjects } from '@/lib/api';
import { formatExperience, humanize, safeHref } from '@/lib/format';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useUrlState } from '@/lib/use-url-state';

const DEFAULTS = {
  page: '1',
  pageSize: '25',
  sort: 'publishedAt',
  order: 'desc',
  q: '',
  city: '',
  industry: '',
  role: '',
  status: 'OPEN',
  skill: '',
  minMatchScore: '',
  project: '',
};
/** `status` defaults to OPEN, so only a different value counts as an active filter. */
const isActive = (state: typeof DEFAULTS, key: keyof typeof DEFAULTS) =>
  state[key] !== DEFAULTS[key];
const FILTER_KEYS = [
  'q',
  'city',
  'industry',
  'role',
  'status',
  'skill',
  'minMatchScore',
  'project',
] as const;

function MinScoreInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const debounced = useDebouncedValue(draft, 400);
  useEffect(() => setDraft(value), [value]);
  const n = Number(draft);
  const invalid = draft !== '' && (!Number.isFinite(n) || n < 0 || n > 100);
  useEffect(() => {
    const ok = debounced === '' || (Number(debounced) >= 0 && Number(debounced) <= 100);
    if (ok && debounced !== value) onChange(debounced);
  }, [debounced]);
  return (
    <>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={100}
        step={5}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="0–100"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
      />
      {invalid && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          Enter a number from 0 to 100.
        </p>
      )}
    </>
  );
}

function buildColumns(opts: { canSortMatch: boolean; hideCompany: boolean }): ColumnDef<JobRow>[] {
  const columns: ColumnDef<JobRow>[] = [
    {
      id: 'title',
      header: 'Job title',
      cell: ({ row }) => (
        <div className="flex min-w-40 flex-col">
          <Link
            href={`/jobs/${row.original.id}`}
            className="font-medium hover:underline focus-visible:underline"
          >
            {row.original.title}
          </Link>
          {(row.original.seniority !== 'UNKNOWN' || row.original.workplaceType !== 'UNKNOWN') && (
            <span className="text-xs text-muted-foreground">
              {[
                row.original.seniority !== 'UNKNOWN' ? humanize(row.original.seniority) : null,
                row.original.workplaceType !== 'UNKNOWN'
                  ? humanize(row.original.workplaceType)
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </div>
      ),
    },
  ];
  if (!opts.hideCompany) {
    columns.push({
      id: 'company',
      header: 'Company',
      cell: ({ row }) => (
        <Link
          href={`/companies/${row.original.companyId}`}
          className="hover:underline focus-visible:underline"
        >
          {row.original.companyName}
        </Link>
      ),
    });
  }
  columns.push(
    {
      id: 'city',
      header: 'City',
      cell: ({ row }) => (
        <span className="block max-w-40 truncate" title={row.original.city ?? undefined}>
          {row.original.city ?? <span className="text-muted-foreground">—</span>}
        </span>
      ),
    },
    {
      id: 'skills',
      header: 'Skills',
      enableSorting: false,
      cell: ({ row }) =>
        row.original.skills.length === 0 ? (
          <span className="text-muted-foreground">
            {row.original.analysisState === 'PENDING' ? 'Analysing…' : '—'}
          </span>
        ) : (
          <div className="flex max-w-64 flex-wrap gap-1">
            {row.original.skills.slice(0, 4).map((s) => (
              <Badge key={s.name} variant={s.kind === 'REQUIRED' ? 'secondary' : 'outline'}>
                {s.name}
              </Badge>
            ))}
            {row.original.skills.length > 4 && (
              <Badge variant="outline">+{row.original.skills.length - 4}</Badge>
            )}
          </div>
        ),
    },
    {
      id: 'experience',
      header: 'Experience',
      enableSorting: false,
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {formatExperience(row.original.minYears, row.original.maxYears)}
        </span>
      ),
    },
    {
      id: 'match',
      header: 'Match score',
      enableSorting: opts.canSortMatch,
      cell: ({ row }) => <MatchScore score={row.original.matchScore} />,
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => <JobStatusBadge status={row.original.status} />,
    },
    {
      id: 'application',
      header: 'Application link',
      enableSorting: false,
      cell: ({ row }) => {
        const apply = safeHref(row.original.applicationUrl);
        const posting = safeHref(row.original.sourceUrl);
        const href = apply ?? posting;
        if (!href) return <span className="text-muted-foreground">—</span>;
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex items-center gap-1 whitespace-nowrap text-primary hover:underline"
          >
            {apply ? 'Apply' : 'View posting'}
            <ExternalLink className="size-3" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        );
      },
    },
  );
  return columns;
}

/**
 * The job table. Match score and sorting by it need a project: fixed with `projectId` (project
 * page) or chosen in the filter bar. `companyId` limits it to one company.
 */
export function JobsTable({
  projectId: fixedProjectId,
  companyId,
  prefix = '',
  chooseProject = false,
}: {
  projectId?: string;
  companyId?: string;
  prefix?: string;
  chooseProject?: boolean;
}) {
  const { state, update, reset } = useUrlState(DEFAULTS, prefix);
  const facets = useQuery({ queryKey: ['facets'], queryFn: getFacets, staleTime: 60_000 });
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
    enabled: chooseProject,
  });
  const projectId = fixedProjectId ?? (state.project || undefined);

  const query = useMemo(
    () => ({
      page: state.page,
      pageSize: state.pageSize,
      // match sorting only exists with a project; fall back rather than error
      sort: state.sort === 'match' && !projectId ? 'publishedAt' : state.sort,
      order: state.order,
      q: state.q,
      city: state.city,
      industry: state.industry,
      role: state.role,
      status: state.status === 'ANY' ? '' : state.status,
      skill: state.skill,
      minMatchScore: state.minMatchScore,
      projectId,
      companyId,
    }),
    [state, projectId, companyId],
  );
  const result = useQuery({
    queryKey: ['jobs', query],
    queryFn: () => listJobDirectory(query),
    placeholderData: (previous) => previous,
  });
  const columns = useMemo(
    () => buildColumns({ canSortMatch: Boolean(projectId), hideCompany: Boolean(companyId) }),
    [projectId, companyId],
  );
  const active = FILTER_KEYS.filter(
    (k) => isActive(state, k) && !(k === 'project' && fixedProjectId),
  ).length;
  const p = prefix;

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <FilterBar activeCount={active} onReset={reset}>
        <FilterField label="Search" htmlFor={`${p}jq`}>
          <SearchBox
            id={`${p}jq`}
            value={state.q}
            onChange={(q) => update({ q })}
            placeholder="Job title or company"
          />
        </FilterField>
        {!companyId && (
          <FilterField label="City" htmlFor={`${p}jcity`}>
            <OptionSelect
              id={`${p}jcity`}
              value={state.city}
              onChange={(city) => update({ city })}
              options={(facets.data?.cities ?? []).map((c) => ({ value: c, label: c }))}
            />
          </FilterField>
        )}
        {!companyId && (
          <FilterField label="Industry" htmlFor={`${p}jindustry`}>
            <OptionSelect
              id={`${p}jindustry`}
              value={state.industry}
              onChange={(industry) => update({ industry })}
              options={(facets.data?.industries ?? []).map((c) => ({ value: c, label: c }))}
            />
          </FilterField>
        )}
        <FilterField label="Job role" htmlFor={`${p}jrole`}>
          <OptionSelect
            id={`${p}jrole`}
            value={state.role}
            onChange={(role) => update({ role })}
            options={(facets.data?.roleCategories ?? []).map((c) => ({
              value: c,
              label: humanize(c),
            }))}
          />
        </FilterField>
        <FilterField label="Job status" htmlFor={`${p}jstatus`}>
          <OptionSelect
            id={`${p}jstatus`}
            value={state.status === 'ANY' ? '' : state.status}
            anyLabel="Any status"
            onChange={(status) => update({ status: status || 'ANY' })}
            options={['OPEN', 'CLOSED', 'EXPIRED', 'UNKNOWN'].map((s) => ({
              value: s,
              label: humanize(s),
            }))}
          />
        </FilterField>
        <FilterField label="Skill" htmlFor={`${p}jskill`}>
          <SearchBox
            id={`${p}jskill`}
            value={state.skill}
            onChange={(skill) => update({ skill })}
            placeholder="e.g. Node.js"
            label="Skill"
          />
        </FilterField>
        {chooseProject && (
          <FilterField label="Match against project" htmlFor={`${p}jproject`}>
            <OptionSelect
              id={`${p}jproject`}
              value={state.project}
              onChange={(project) =>
                update({ project, ...(project ? {} : { minMatchScore: '', sort: DEFAULTS.sort }) })
              }
              options={(projects.data?.items ?? []).map((pr) => ({ value: pr.id, label: pr.name }))}
              anyLabel="Best across projects"
            />
          </FilterField>
        )}
        <FilterField label="Minimum match score" htmlFor={`${p}jscore`}>
          <MinScoreInput
            id={`${p}jscore`}
            value={state.minMatchScore}
            onChange={(minMatchScore) => update({ minMatchScore })}
          />
        </FilterField>
      </FilterBar>

      <ServerTable
        label="Jobs"
        columns={columns}
        data={result.data?.items}
        isLoading={result.isPending}
        isFetching={result.isFetching}
        error={result.error}
        onRetry={() => void result.refetch()}
        page={Number(state.page) || 1}
        pageSize={Number(state.pageSize) || 25}
        total={result.data?.total}
        totalPages={result.data?.totalPages}
        sort={state.sort === 'match' && !projectId ? 'publishedAt' : state.sort}
        order={state.order === 'asc' ? 'asc' : 'desc'}
        onSortChange={(sort, order) => update({ sort, order })}
        onPageChange={(page) => update({ page: String(page) })}
        onPageSizeChange={(pageSize) => update({ pageSize: String(pageSize) })}
        rowKey={(row) => row.id}
        empty={{
          title: active > 0 ? 'No jobs match these filters' : 'No jobs yet',
          description:
            active > 0
              ? 'Try removing a filter or searching for something else.'
              : 'Jobs appear after a company’s careers page or job board has been checked. Open a company and refresh its jobs.',
        }}
      />
    </Card>
  );
}
