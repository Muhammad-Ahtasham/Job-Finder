import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ErrorState } from '@/components/states';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Skeleton while loading, a retryable error if it failed, otherwise the content. */
export function QueryBoundary<T>({
  query,
  children,
  height = 'h-40',
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  height?: string;
}) {
  if (query.isPending) {
    return <Skeleton className={`${height} w-full`} aria-busy="true" />;
  }
  if (query.error) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }
  return <>{children(query.data as T)}</>;
}
