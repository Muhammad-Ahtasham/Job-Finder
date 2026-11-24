'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AuthedPage } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { createProject, listProjects } from '@/lib/api';

/** One entry per line or comma-separated; the API trims and de-duplicates. */
const splitList = (value: string) =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

const statusVariant = (status: string) =>
  status === 'COMPLETED' ? 'success' : status === 'FAILED' ? 'destructive' : 'secondary';

function NewProjectForm({ onCreated }: { onCreated: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (form: FormData) =>
      createProject({
        name: String(form.get('name') ?? ''),
        country: String(form.get('country') ?? '') || undefined,
        city: String(form.get('city') ?? ''),
        industry: String(form.get('industry') ?? ''),
        keywords: splitList(String(form.get('keywords') ?? '')),
        targetRoles: splitList(String(form.get('targetRoles') ?? '')),
        targetSkills: splitList(String(form.get('targetSkills') ?? '')),
      }),
    onSuccess: onCreated,
    onError: (err: Error) => setError(err.message),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    create.mutate(new FormData(event.currentTarget));
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate>
        <CardHeader>
          <CardTitle>New search project</CardTitle>
          <CardDescription>
            Describe where to look; discovery runs are started from the project.
          </CardDescription>
        </CardHeader>
        <CardContent className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="name">Project name</Label>
            <Input id="name" name="name" placeholder="Lahore Software Houses" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="country">Country (ISO code)</Label>
            <Input id="country" name="country" defaultValue="PK" maxLength={2} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="city">City</Label>
            <Input id="city" name="city" placeholder="Lahore" required />
          </div>
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="industry">Industry</Label>
            <Input id="industry" name="industry" placeholder="Software Development" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="keywords">Search keywords (one per line)</Label>
            <Textarea
              id="keywords"
              name="keywords"
              rows={5}
              placeholder={'Software House\nIT Company'}
              required
            />
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="targetRoles">Target roles (one per line)</Label>
              <Textarea
                id="targetRoles"
                name="targetRoles"
                rows={2}
                placeholder="Backend Developer"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="targetSkills">Target skills (one per line)</Label>
              <Textarea id="targetSkills" name="targetSkills" rows={2} placeholder="TypeScript" />
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm whitespace-pre-line text-destructive sm:col-span-2">
              {error}
            </p>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create project'}
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}

function ProjectList() {
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery({ queryKey: ['projects'], queryFn: listProjects });
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Projects</h1>
        <Button onClick={() => setShowForm((v) => !v)} variant={showForm ? 'outline' : 'default'}>
          {showForm ? 'Cancel' : 'New project'}
        </Button>
      </div>

      {showForm && (
        <NewProjectForm
          onCreated={() => {
            setShowForm(false);
            void queryClient.invalidateQueries({ queryKey: ['projects'] });
          }}
        />
      )}

      {isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {data && data.items.length === 0 && !showForm && (
        <p className="text-sm text-muted-foreground">
          No projects yet. Create one to start discovering companies.
        </p>
      )}

      <ul className="flex flex-col gap-3" data-testid="project-list">
        {data?.items.map((project) => (
          <li key={project.id}>
            <Link href={`/projects/${project.id}`}>
              <Card className="gap-2 py-4 transition-colors hover:bg-accent">
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle>{project.name}</CardTitle>
                  {project.lastRun && (
                    <Badge variant={statusVariant(project.lastRun.status)}>
                      {project.lastRun.status}
                    </Badge>
                  )}
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  {project.industry} · {project.city}, {project.country} · {project.keywords.length}{' '}
                  keyword
                  {project.keywords.length === 1 ? '' : 's'}
                </CardContent>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ProjectsPage() {
  return <AuthedPage>{() => <ProjectList />}</AuthedPage>;
}
