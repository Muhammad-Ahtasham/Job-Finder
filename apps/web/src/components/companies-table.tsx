'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ExternalLink } from 'lucide-react';
import type { CompanyRow } from '@jobfinder/contracts';
import { FieldStatusBadge } from '@/components/badges';
import { ServerTable } from '@/components/data-table';
import { FilterBar, FilterField, OptionSelect, SearchBox, TriSelect } from '@/components/filters';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { getFacets, listCompanyDirectory } from '@/lib/api';
import { displayUrl, safeHref } from '@/lib/format';
import { useUrlState } from '@/lib/use-url-state';

const DEFAULTS = {
  page: '1',
  pageSize: '25',
  sort: 'createdAt',
  order: 'desc',
  q: '',
  city: '',
  industry: '',
  websiteStatus: '',
  hasWebsite: '',
  hasHrEmail: '',
  hasCareersPage: '',
  hiring: '',
};
const FILTER_KEYS = [
  'q',
  'city',
  'industry',
  'websiteStatus',
  'hasWebsite',
  'hasHrEmail',
  'hasCareersPage',
  'hiring',
] as const;

function ExternalLinkCell({ url, label }: { url: string | null; label?: string }) {
  const href = safeHref(url);
  if (!url) return <span className="text-muted-foreground">—</span>;
  if (!href) return <span className="max-w-40 truncate">{url}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="inline-flex max-w-44 items-center gap-1 text-primary hover:underline"
    >
      <span className="truncate">{label ?? displayUrl(href)}</span>
      <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

const columns: ColumnDef<CompanyRow>[] = [
  {
    id: 'name',
    header: 'Company',
    cell: ({ row }) => (
      <Link
        href={`/companies/${row.original.id}`}
        className="font-medium hover:underline focus-visible:underline"
      >
        {row.original.displayName}
      </Link>
    ),
  },
  {
    id: 'industry',
    header: 'Industry',
    enableSorting: false,
    cell: ({ row }) =>
      row.original.industries.length === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {row.original.industries.slice(0, 2).map((i) => (
            <Badge key={i} variant="secondary">
              {i}
            </Badge>
          ))}
        </div>
      ),
  },
  {
    id: 'city',
    header: 'City',
    cell: ({ row }) => row.original.city ?? <span className="text-muted-foreground">—</span>,
  },
  {
    id: 'website',
    header: 'Website',
    enableSorting: false,
    cell: ({ row }) => <ExternalLinkCell url={row.original.website} />,
  },
  {
    id: 'websiteStatus',
    header: 'Website status',
    cell: ({ row }) => <FieldStatusBadge status={row.original.websiteStatus} />,
  },
  {
    id: 'hrEmail',
    header: 'HR email',
    enableSorting: false,
    cell: ({ row }) =>
      row.original.hrEmail ? (
        <a
          href={`mailto:${row.original.hrEmail}`}
          className="block max-w-44 truncate text-primary hover:underline"
        >
          {row.original.hrEmail}
        </a>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: 'careers',
    header: 'Careers page',
    enableSorting: false,
    cell: ({ row }) =>
      row.original.careersUrl ? (
        <ExternalLinkCell url={row.original.careersUrl} label="Careers" />
      ) : (
        <FieldStatusBadge status={row.original.careersStatus} />
      ),
  },
  {
    id: 'linkedin',
    header: 'LinkedIn',
    enableSorting: false,
    cell: ({ row }) => <ExternalLinkCell url={row.original.linkedin} label="LinkedIn" />,
  },
  {
    id: 'hiring',
    header: 'Hiring status',
    enableSorting: false,
    cell: ({ row }) =>
      row.original.hiring ? (
        <Badge variant="success">Hiring · {row.original.openJobs} open</Badge>
      ) : row.original.jobCount > 0 ? (
        <Badge variant="secondary">No open jobs</Badge>
      ) : (
        <Badge variant="outline">No jobs known</Badge>
      ),
  },
  {
    id: 'jobCount',
    header: 'Jobs',
    cell: ({ row }) => <span className="tabular-nums">{row.original.jobCount}</span>,
  },
];

/**
 * The company table: filters, search, sorting and paging all run on the server. `projectId`
 * limits it to companies a project discovered; `prefix` keeps URL state apart when two tables
 * share a page.
 */
export function CompaniesTable({
  projectId,
  prefix = '',
}: {
  projectId?: string;
  prefix?: string;
}) {
  const { state, update, reset } = useUrlState(DEFAULTS, prefix);
  const facets = useQuery({ queryKey: ['facets'], queryFn: getFacets, staleTime: 60_000 });

  const query = useMemo(
    () => ({
      page: state.page,
      pageSize: state.pageSize,
      sort: state.sort,
      order: state.order,
      q: state.q,
      city: state.city,
      industry: state.industry,
      websiteStatus: state.websiteStatus,
      hasWebsite: state.hasWebsite,
      hasHrEmail: state.hasHrEmail,
      hasCareersPage: state.hasCareersPage,
      hiring: state.hiring,
      projectId,
    }),
    [state, projectId],
  );
  const result = useQuery({
    queryKey: ['companies', query],
    queryFn: () => listCompanyDirectory(query),
    placeholderData: (previous) => previous,
  });
  const active = FILTER_KEYS.filter((k) => state[k] !== '').length;
  const p = prefix;

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <FilterBar activeCount={active} onReset={reset}>
        <FilterField label="Search" htmlFor={`${p}q`}>
          <SearchBox
            id={`${p}q`}
            value={state.q}
            onChange={(q) => update({ q })}
            placeholder="Name or domain"
          />
        </FilterField>
        <FilterField label="City" htmlFor={`${p}city`}>
          <OptionSelect
            id={`${p}city`}
            value={state.city}
            onChange={(city) => update({ city })}
            options={(facets.data?.cities ?? []).map((c) => ({ value: c, label: c }))}
          />
        </FilterField>
        <FilterField label="Industry" htmlFor={`${p}industry`}>
          <OptionSelect
            id={`${p}industry`}
            value={state.industry}
            onChange={(industry) => update({ industry })}
            options={(facets.data?.industries ?? []).map((c) => ({ value: c, label: c }))}
          />
        </FilterField>
        <FilterField label="Verification status (website)" htmlFor={`${p}websiteStatus`}>
          <OptionSelect
            id={`${p}websiteStatus`}
            value={state.websiteStatus}
            onChange={(websiteStatus) => update({ websiteStatus })}
            options={[
              { value: 'VERIFIED', label: 'Verified' },
              { value: 'UNVERIFIED', label: 'Unverified' },
              { value: 'MISSING', label: 'Missing' },
              { value: 'FAILED', label: 'Failed' },
            ]}
          />
        </FilterField>
        <FilterField label="Has website" htmlFor={`${p}hasWebsite`}>
          <TriSelect
            id={`${p}hasWebsite`}
            value={state.hasWebsite}
            onChange={(hasWebsite) => update({ hasWebsite })}
          />
        </FilterField>
        <FilterField label="Has HR email" htmlFor={`${p}hasHrEmail`}>
          <TriSelect
            id={`${p}hasHrEmail`}
            value={state.hasHrEmail}
            onChange={(hasHrEmail) => update({ hasHrEmail })}
          />
        </FilterField>
        <FilterField label="Has careers page" htmlFor={`${p}hasCareersPage`}>
          <TriSelect
            id={`${p}hasCareersPage`}
            value={state.hasCareersPage}
            onChange={(hasCareersPage) => update({ hasCareersPage })}
          />
        </FilterField>
        <FilterField label="Currently hiring" htmlFor={`${p}hiring`}>
          <TriSelect
            id={`${p}hiring`}
            value={state.hiring}
            onChange={(hiring) => update({ hiring })}
          />
        </FilterField>
      </FilterBar>

      <ServerTable
        label="Companies"
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
        sort={state.sort}
        order={state.order === 'asc' ? 'asc' : 'desc'}
        onSortChange={(sort, order) => update({ sort, order })}
        onPageChange={(page) => update({ page: String(page) })}
        onPageSizeChange={(pageSize) => update({ pageSize: String(pageSize) })}
        rowKey={(row) => row.id}
        empty={{
          title: active > 0 ? 'No companies match these filters' : 'No companies yet',
          description:
            active > 0
              ? 'Try removing a filter or searching for something else.'
              : 'Start a discovery run in a search project to find companies.',
        }}
      />
    </Card>
  );
}
