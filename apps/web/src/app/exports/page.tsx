'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { AuthedPage } from '@/components/app-shell';
import { FilterField, OptionSelect, TriSelect } from '@/components/filters';
import { PageHeader } from '@/components/states';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { exportUrl, getFacets, listProjects } from '@/lib/api';
import { cn } from '@/lib/utils';

function Exports() {
  const facets = useQuery({ queryKey: ['facets'], queryFn: getFacets, staleTime: 60_000 });
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects });
  const [company, setCompany] = useState({
    projectId: '',
    city: '',
    hasHrEmail: '',
    hasCareersPage: '',
    hiring: '',
  });
  const [job, setJob] = useState({ projectId: '', status: 'OPEN', city: '', role: '' });
  const projectOptions = (projects.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }));
  const cities = (facets.data?.cities ?? []).map((c) => ({ value: c, label: c }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Exports"
        description="Download what you see as CSV. Filters are applied on the server; up to 5,000 rows per file."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Companies</CardTitle>
            <CardDescription>
              Website, HR email, careers page, LinkedIn and hiring status.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <FilterField label="Project" htmlFor="ec-project">
                <OptionSelect
                  id="ec-project"
                  value={company.projectId}
                  options={projectOptions}
                  anyLabel="All projects"
                  onChange={(projectId) => setCompany({ ...company, projectId })}
                />
              </FilterField>
              <FilterField label="City" htmlFor="ec-city">
                <OptionSelect
                  id="ec-city"
                  value={company.city}
                  options={cities}
                  onChange={(city) => setCompany({ ...company, city })}
                />
              </FilterField>
              <FilterField label="Has HR email" htmlFor="ec-hr">
                <TriSelect
                  id="ec-hr"
                  value={company.hasHrEmail}
                  onChange={(hasHrEmail) => setCompany({ ...company, hasHrEmail })}
                />
              </FilterField>
              <FilterField label="Has careers page" htmlFor="ec-careers">
                <TriSelect
                  id="ec-careers"
                  value={company.hasCareersPage}
                  onChange={(hasCareersPage) => setCompany({ ...company, hasCareersPage })}
                />
              </FilterField>
              <FilterField label="Currently hiring" htmlFor="ec-hiring">
                <TriSelect
                  id="ec-hiring"
                  value={company.hiring}
                  onChange={(hiring) => setCompany({ ...company, hiring })}
                />
              </FilterField>
            </div>
            <a
              className={cn(buttonVariants(), 'self-start')}
              href={exportUrl('companies', company)}
              download="companies.csv"
            >
              <Download className="size-4" aria-hidden="true" />
              Download companies CSV
            </a>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Jobs</CardTitle>
            <CardDescription>
              Title, company, skills, experience, match score and application link.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <FilterField label="Project (adds match score)" htmlFor="ej-project">
                <OptionSelect
                  id="ej-project"
                  value={job.projectId}
                  options={projectOptions}
                  anyLabel="Best across projects"
                  onChange={(projectId) => setJob({ ...job, projectId })}
                />
              </FilterField>
              <FilterField label="Job status" htmlFor="ej-status">
                <OptionSelect
                  id="ej-status"
                  value={job.status}
                  anyLabel="Any status"
                  options={['OPEN', 'CLOSED', 'EXPIRED', 'UNKNOWN'].map((s) => ({
                    value: s,
                    label: s.charAt(0) + s.slice(1).toLowerCase(),
                  }))}
                  onChange={(status) => setJob({ ...job, status })}
                />
              </FilterField>
              <FilterField label="City" htmlFor="ej-city">
                <OptionSelect
                  id="ej-city"
                  value={job.city}
                  options={cities}
                  onChange={(city) => setJob({ ...job, city })}
                />
              </FilterField>
              <FilterField label="Job role" htmlFor="ej-role">
                <OptionSelect
                  id="ej-role"
                  value={job.role}
                  options={(facets.data?.roleCategories ?? []).map((r) => ({
                    value: r,
                    label: r.replace(/_/g, ' ').toLowerCase(),
                  }))}
                  onChange={(role) => setJob({ ...job, role })}
                />
              </FilterField>
            </div>
            <a
              className={cn(buttonVariants(), 'self-start')}
              href={exportUrl('jobs', job)}
              download="jobs.csv"
            >
              <Download className="size-4" aria-hidden="true" />
              Download jobs CSV
            </a>
          </CardContent>
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">
        Exports contain only data published by the companies themselves or by public job boards,
        scoped to your active workspace.
      </p>
    </div>
  );
}

export default function ExportsPage() {
  return <AuthedPage>{() => <Exports />}</AuthedPage>;
}
