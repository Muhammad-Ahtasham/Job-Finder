import type { RunProgress as RunProgressData } from '@jobfinder/contracts';
import { RunStatusBadge } from '@/components/badges';

/** Live state of one discovery run: overall percentage, counts and per-provider detail. */
export function RunProgress({ progress }: { progress: RunProgressData }) {
  const t = progress.tasks;
  return (
    <div className="flex flex-col gap-4" data-testid="run-progress">
      <div className="flex items-center gap-3">
        <RunStatusBadge status={progress.status} />
        {progress.cancelRequested && progress.status === 'RUNNING' && (
          <span className="text-xs text-muted-foreground">cancelling…</span>
        )}
        <div
          className="h-2 flex-1 overflow-hidden rounded bg-secondary"
          role="progressbar"
          aria-label="Run progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent}
        >
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
        <span className="text-sm tabular-nums">{progress.percent}%</span>
      </div>

      {progress.error && (
        <p role="alert" className="text-sm text-destructive">
          {progress.error}
        </p>
      )}
      {progress.skippedProviders.length > 0 && (
        <ul className="text-xs text-muted-foreground">
          {progress.skippedProviders.map((p) => (
            <li key={p.id}>
              Provider <code>{p.id}</code> not used: {p.reason}
            </li>
          ))}
        </ul>
      )}

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {[
          ['Found', progress.stats.candidatesFound],
          ['New companies', progress.stats.companiesCreated],
          ['Matched existing', progress.stats.companiesMatched],
          ['Need review', progress.stats.reviewsCreated],
        ].map(([label, value]) => (
          <div key={label as string}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="text-xs text-muted-foreground">
        Tasks: {t.succeeded} done · {t.running} running · {t.queued} queued · {t.retrying} retrying
        · {t.failed} failed · {t.cancelled} cancelled · {progress.stats.duplicatesSkipped}{' '}
        duplicates skipped · {progress.stats.candidatesFiltered} non-company results filtered
      </p>

      {progress.providers.map((provider) => (
        <div key={provider.providerId} className="rounded-md border p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">{provider.displayName}</span>
            <span className="text-muted-foreground">
              {provider.tasks.succeeded}/{provider.tasks.total} tasks · {provider.candidatesFound}{' '}
              found
            </span>
          </div>
          {provider.attribution && (
            <p className="text-xs text-muted-foreground">{provider.attribution}</p>
          )}
          {provider.errors.map((error) => (
            <p key={error.taskId} className="mt-1 text-xs text-destructive">
              {error.keyword ?? 'area search'}: {error.code} (
              {error.retryable ? 'retrying' : 'failed'}, attempt {error.attempts}) — {error.message}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}
