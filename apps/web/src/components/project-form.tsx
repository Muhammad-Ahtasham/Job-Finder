'use client';

import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createProjectRequestSchema, type Project } from '@jobfinder/contracts';
import { TagInput } from '@/components/tag-input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createProject } from '@/lib/api';

interface Values {
  name: string;
  country: string;
  city: string;
  industry: string;
  keywords: string[];
  targetRoles: string[];
  targetSkills: string[];
}
type Errors = Partial<Record<keyof Values, string>>;

const EMPTY: Values = {
  name: '',
  country: 'PK',
  city: '',
  industry: '',
  keywords: [],
  targetRoles: [],
  targetSkills: [],
};

/** Field-level messages from the same schema the API enforces. */
function validate(values: Values): {
  errors: Errors;
  data?: ReturnType<typeof createProjectRequestSchema.parse>;
} {
  const result = createProjectRequestSchema.safeParse(values);
  if (result.success) return { errors: {}, data: result.data };
  const errors: Errors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0] as keyof Values | undefined;
    if (key && !errors[key]) errors[key] = issue.message;
  }
  return { errors };
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function ProjectForm({
  onCreated,
  onCancel,
}: {
  onCreated: (project: Project) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Values>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<keyof Values, boolean>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: createProject,
    onSuccess: onCreated,
    onError: (error: Error) => setServerError(error.message),
  });

  const { errors } = validate(values);
  const shown = (key: keyof Values) => (touched[key] ? errors[key] : undefined);
  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((v) => ({ ...v, [key]: value }));
  const touch = (key: keyof Values) => setTouched((t) => ({ ...t, [key]: true }));
  const aria = (key: keyof Values) => ({
    'aria-invalid': shown(key) ? true : undefined,
    'aria-describedby': shown(key) ? `${key}-error` : `${key}-hint`,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setServerError(null);
    const { data, errors: found } = validate(values);
    if (!data) {
      setTouched({
        name: true,
        country: true,
        city: true,
        industry: true,
        keywords: true,
        targetRoles: true,
        targetSkills: true,
      });
      // Move focus to the first invalid field so the problem is announced.
      const first = Object.keys(found)[0];
      if (first) document.getElementById(first)?.focus();
      return;
    }
    create.mutate(data);
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate aria-label="New search project">
        <CardHeader>
          <CardTitle>New search project</CardTitle>
          <CardDescription>
            Describe where to look. Target roles and skills are used to score the jobs found.
          </CardDescription>
        </CardHeader>
        <CardContent className="mt-6 grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field id="name" label="Project name" error={shown('name')}>
              <Input
                id="name"
                value={values.name}
                onChange={(e) => set('name', e.target.value)}
                onBlur={() => touch('name')}
                placeholder="Lahore software houses"
                maxLength={120}
                required
                {...aria('name')}
              />
            </Field>
          </div>
          <Field
            id="country"
            label="Country (ISO code)"
            hint="Two letters, e.g. PK."
            error={shown('country')}
          >
            <Input
              id="country"
              value={values.country}
              onChange={(e) => set('country', e.target.value.toUpperCase())}
              onBlur={() => touch('country')}
              maxLength={2}
              autoCapitalize="characters"
              required
              {...aria('country')}
            />
          </Field>
          <Field id="city" label="City" error={shown('city')}>
            <Input
              id="city"
              value={values.city}
              onChange={(e) => set('city', e.target.value)}
              onBlur={() => touch('city')}
              placeholder="Lahore"
              maxLength={100}
              required
              {...aria('city')}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field id="industry" label="Industry" error={shown('industry')}>
              <Input
                id="industry"
                value={values.industry}
                onChange={(e) => set('industry', e.target.value)}
                onBlur={() => touch('industry')}
                placeholder="Software development"
                maxLength={100}
                required
                {...aria('industry')}
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field
              id="keywords"
              label="Search keywords"
              hint="Press Enter or comma after each one, e.g. “software house”. At least one."
              error={shown('keywords')}
            >
              <TagInput
                id="keywords"
                noun="keyword"
                max={20}
                value={values.keywords}
                onChange={(v) => {
                  set('keywords', v);
                  touch('keywords');
                }}
                placeholder="Add a keyword"
                invalid={!!shown('keywords')}
                describedBy={shown('keywords') ? 'keywords-error' : 'keywords-hint'}
              />
            </Field>
          </div>
          <Field
            id="targetRoles"
            label="Target roles"
            hint="Optional. e.g. Backend Developer."
            error={shown('targetRoles')}
          >
            <TagInput
              id="targetRoles"
              noun="role"
              max={20}
              value={values.targetRoles}
              onChange={(v) => set('targetRoles', v)}
              placeholder="Add a role"
              invalid={!!shown('targetRoles')}
              describedBy="targetRoles-hint"
            />
          </Field>
          <Field
            id="targetSkills"
            label="Target skills"
            hint="Optional. e.g. TypeScript, PostgreSQL."
            error={shown('targetSkills')}
          >
            <TagInput
              id="targetSkills"
              noun="skill"
              max={50}
              value={values.targetSkills}
              onChange={(v) => set('targetSkills', v)}
              placeholder="Add a skill"
              invalid={!!shown('targetSkills')}
              describedBy="targetSkills-hint"
            />
          </Field>

          {serverError && (
            <p role="alert" className="text-sm whitespace-pre-line text-destructive sm:col-span-2">
              {serverError}
            </p>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create project'}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
