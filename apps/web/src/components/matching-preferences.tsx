'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MatchPreferences } from '@jobfinder/contracts';
import { TagInput } from '@/components/tag-input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/states';
import { getMatchPreferences, refreshMatches, updateMatchPreferences } from '@/lib/api';
import { humanize } from '@/lib/format';

const WEIGHTS = [
  ['role', 'Role similarity'],
  ['skills', 'Skills overlap'],
  ['experience', 'Experience fit'],
  ['location', 'Location / workplace fit'],
] as const;
const SENIORITIES = [
  'INTERN',
  'JUNIOR',
  'MID',
  'SENIOR',
  'LEAD',
  'MANAGER',
  'DIRECTOR',
  'EXECUTIVE',
] as const;
const WORKPLACES = ['ONSITE', 'HYBRID', 'REMOTE'] as const;

interface Draft {
  weights: Record<(typeof WEIGHTS)[number][0], string>;
  yearsExperience: string;
  seniorities: string[];
  workplaceTypes: string[];
  locations: string[];
  minScore: string;
}

const toDraft = (p: MatchPreferences): Draft => ({
  weights: Object.fromEntries(
    WEIGHTS.map(([k]) => [k, String(Math.round(p.weights[k] * 100))]),
  ) as Draft['weights'],
  yearsExperience: p.yearsExperience === null ? '' : String(p.yearsExperience),
  seniorities: p.seniorities,
  workplaceTypes: p.workplaceTypes,
  locations: p.locations,
  minScore: String(p.minScore),
});

const toggle = (list: string[], value: string) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

/** Editing this recalculates every match of the project in the background. */
export function MatchingPreferences({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const prefs = useQuery({
    queryKey: ['match-preferences', projectId],
    queryFn: () => getMatchPreferences(projectId),
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (prefs.data) setDraft(toDraft(prefs.data));
  }, [prefs.data]);

  const save = useMutation({
    mutationFn: (input: Parameters<typeof updateMatchPreferences>[1]) =>
      updateMatchPreferences(projectId, input),
    onSuccess: (data) => {
      setSaved(true);
      setErrors([]);
      queryClient.setQueryData(['match-preferences', projectId], data);
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (e: Error) => setErrors(e.message.split('\n')),
  });
  const refresh = useMutation({
    mutationFn: () => refreshMatches(projectId),
    onSuccess: () => setSaved(true),
  });

  if (prefs.isPending || !draft) {
    return prefs.error ? (
      <Card>
        <ErrorState error={prefs.error} onRetry={() => void prefs.refetch()} />
      </Card>
    ) : (
      <Skeleton className="h-64 w-full" />
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const problems: string[] = [];
    const weights: Record<string, number> = {};
    for (const [key, label] of WEIGHTS) {
      const n = Number(draft.weights[key]);
      if (draft.weights[key] === '' || !Number.isFinite(n) || n < 0 || n > 100)
        problems.push(`${label}: enter 0–100`);
      else weights[key] = n / 100;
    }
    if (problems.length === 0 && Object.values(weights).every((w) => w === 0))
      problems.push('At least one weight must be above 0');
    const years = draft.yearsExperience === '' ? null : Number(draft.yearsExperience);
    if (years !== null && (!Number.isInteger(years) || years < 0 || years > 60))
      problems.push('Years of experience: a whole number from 0 to 60');
    const minScore = Number(draft.minScore || 0);
    if (!Number.isInteger(minScore) || minScore < 0 || minScore > 100)
      problems.push('Minimum score: a whole number from 0 to 100');
    setErrors(problems);
    if (problems.length > 0) return;
    save.mutate({
      weights: weights as never,
      yearsExperience: years,
      seniorities: draft.seniorities as never,
      workplaceTypes: draft.workplaceTypes as never,
      locations: draft.locations,
      minScore,
    });
  };

  const set = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft({ ...draft, ...patch });
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate aria-label="Matching preferences">
        <CardHeader>
          <CardTitle>Matching preferences</CardTitle>
          <CardDescription>
            Weights are relative (they are rescaled to add up to 100%). Saving recalculates the
            project’s matches.
          </CardDescription>
        </CardHeader>
        <CardContent className="mt-6 flex flex-col gap-6">
          <fieldset className="grid gap-3 sm:grid-cols-4">
            <legend className="mb-2 text-sm font-medium">Weights (%)</legend>
            {WEIGHTS.map(([key, label]) => (
              <div key={key} className="flex flex-col gap-1.5">
                <Label htmlFor={`w-${key}`} className="text-xs text-muted-foreground">
                  {label}
                </Label>
                <Input
                  id={`w-${key}`}
                  type="number"
                  min={0}
                  max={100}
                  inputMode="numeric"
                  value={draft.weights[key]}
                  onChange={(e) => set({ weights: { ...draft.weights, [key]: e.target.value } })}
                />
              </div>
            ))}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="years">Years of experience wanted</Label>
              <Input
                id="years"
                type="number"
                min={0}
                max={60}
                value={draft.yearsExperience}
                onChange={(e) => set({ yearsExperience: e.target.value })}
                placeholder="Not specified"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="minScore">Hide matches below score</Label>
              <Input
                id="minScore"
                type="number"
                min={0}
                max={100}
                value={draft.minScore}
                onChange={(e) => set({ minScore: e.target.value })}
              />
            </div>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Seniority</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {SENIORITIES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={draft.seniorities.includes(s)}
                    onChange={() => set({ seniorities: toggle(draft.seniorities, s) })}
                  />
                  {humanize(s)}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Workplace</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {WORKPLACES.map((w) => (
                <label key={w} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={draft.workplaceTypes.includes(w)}
                    onChange={() => set({ workplaceTypes: toggle(draft.workplaceTypes, w) })}
                  />
                  {humanize(w)}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="locations">Preferred locations</Label>
            <TagInput
              id="locations"
              noun="location"
              max={20}
              value={draft.locations}
              onChange={(locations) => set({ locations })}
              placeholder="Defaults to the project’s city and country"
              describedBy="locations-hint"
            />
          </div>

          {errors.length > 0 && (
            <ul role="alert" className="text-sm text-destructive">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save and recalculate'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
            >
              Recalculate now
            </Button>
            {saved && (
              <span role="status" className="text-sm text-muted-foreground">
                Saved. Scores update in the background.
              </span>
            )}
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
