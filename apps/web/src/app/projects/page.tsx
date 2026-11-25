'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { RunStatusBadge } from '@/components/badges';
import { AuthedPage } from '@/components/app-shell';
import { ProjectForm } from '@/components/project-form';
import { EmptyState, ErrorState, PageHeader } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listProjects } from '@/lib/api';
import { timeAgo } from '@/lib/format';

function ProjectList() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const projects = useQuery({ queryKey: ['projects'], queryFn: listProjects });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Search projects"
        description="A project says where and what to search for. Start discovery runs from it."
        actions={
          !showForm && (
            <Button onClick={() => setShowForm(true)}>
              <Plus className="size-4" aria-hidden="true" />
              New project
            </Button>
          )
        }
      />

      {showForm && (
        <ProjectForm
          onCancel={() => setShowForm(false)}
          onCreated={(project) => {
            void queryClient.invalidateQueries({ queryKey: ['projects'] });
            void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
            router.push(`/projects/${project.id}`);
          }}
        />
      )}

      <Card className="gap-0 overflow-hidden py-0">
        {projects.isPending ? (
          <div className="flex flex-col gap-3 p-4" aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : projects.error ? (
          <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
        ) : projects.data.items.length === 0 ? (
          <EmptyState
            title="No projects yet"
            description="Create a project to start discovering companies."
            action={
              !showForm && (
                <Button size="sm" onClick={() => setShowForm(true)}>
                  New project
                </Button>
              )
            }
          />
        ) : (
          <Table aria-label="Search projects" data-testid="project-list">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Project</TableHead>
                <TableHead>Industry</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Keywords</TableHead>
                <TableHead>Last run</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.data.items.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Link
                      href={`/projects/${p.id}`}
                      className="font-medium hover:underline focus-visible:underline"
                    >
                      {p.name}
                    </Link>
                  </TableCell>
                  <TableCell>{p.industry}</TableCell>
                  <TableCell>
                    {p.city}, {p.country}
                  </TableCell>
                  <TableCell>
                    <div className="flex max-w-64 flex-wrap gap-1">
                      {p.keywords.slice(0, 3).map((k) => (
                        <Badge key={k} variant="secondary">
                          {k}
                        </Badge>
                      ))}
                      {p.keywords.length > 3 && (
                        <Badge variant="outline">+{p.keywords.length - 3}</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {p.lastRun ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <RunStatusBadge status={p.lastRun.status} />
                        <span className="text-xs text-muted-foreground">
                          {p.lastRun.stats.candidatesFound} found · {timeAgo(p.lastRun.createdAt)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Not run yet</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

export default function ProjectsPage() {
  return <AuthedPage>{() => <ProjectList />}</AuthedPage>;
}
