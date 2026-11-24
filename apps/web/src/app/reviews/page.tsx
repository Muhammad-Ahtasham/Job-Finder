'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CompanySummary, MatchReview } from '@jobfinder/contracts';
import { AuthedPage } from '@/components/app-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { dismissReview, listReviews, mergeReview } from '@/lib/api';

function CompanyColumn({ title, company }: { title: string; company: CompanySummary }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{title}</span>
      <span className="font-medium">{company.displayName}</span>
      <span className="text-muted-foreground">{company.city ?? 'city unknown'}</span>
      <span className="text-muted-foreground">{company.website ?? 'no website'}</span>
      <span className="text-xs text-muted-foreground">{company.sourceCount} source(s)</span>
    </div>
  );
}

function ReviewCard({ review, onResolved }: { review: MatchReview; onResolved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const merge = useMutation({
    mutationFn: () => mergeReview(review.id),
    onSuccess: onResolved,
    onError: (e: Error) => setError(e.message),
  });
  const dismiss = useMutation({
    mutationFn: () => dismissReview(review.id),
    onSuccess: onResolved,
    onError: (e: Error) => setError(e.message),
  });
  const busy = merge.isPending || dismiss.isPending;

  return (
    <Card className="gap-4">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">Possible duplicate</CardTitle>
        <Badge variant="warning">match score {review.score.toFixed(2)}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-6 sm:grid-cols-2">
          <CompanyColumn title="Existing" company={review.existing} />
          <CompanyColumn title="New candidate" company={review.candidate} />
        </div>
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {review.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => merge.mutate()} disabled={busy}>
            Same company — merge
          </Button>
          <Button size="sm" variant="outline" onClick={() => dismiss.mutate()} disabled={busy}>
            Different companies
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Reviews() {
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery({ queryKey: ['reviews'], queryFn: listReviews });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['reviews'] });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Match reviews</h1>
        <p className="text-sm text-muted-foreground">
          Discovery never merges an uncertain match automatically. Both companies are kept until you
          decide.
        </p>
      </div>
      {isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {data?.items.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing to review.</p>
      )}
      {data?.items.map((review) => (
        <ReviewCard key={review.id} review={review} onResolved={refresh} />
      ))}
    </div>
  );
}

export default function ReviewsPage() {
  return <AuthedPage>{() => <Reviews />}</AuthedPage>;
}
