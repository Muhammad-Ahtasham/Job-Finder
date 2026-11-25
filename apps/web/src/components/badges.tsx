import { Badge } from '@/components/ui/badge';
import { humanize } from '@/lib/format';

type Variant = 'default' | 'secondary' | 'outline' | 'destructive' | 'success' | 'warning';

const FIELD: Record<string, { variant: Variant; label: string }> = {
  VERIFIED: { variant: 'success', label: 'Verified' },
  UNVERIFIED: { variant: 'warning', label: 'Unverified' },
  FAILED: { variant: 'destructive', label: 'Failed' },
  MISSING: { variant: 'outline', label: 'Missing' },
};

/** Verification state of a company field (website, email, careers). */
export function FieldStatusBadge({ status }: { status: string }) {
  const entry = FIELD[status] ?? { variant: 'outline' as const, label: humanize(status) };
  return <Badge variant={entry.variant}>{entry.label}</Badge>;
}

const JOB: Record<string, Variant> = {
  OPEN: 'success',
  CLOSED: 'secondary',
  EXPIRED: 'outline',
  UNKNOWN: 'warning',
};
export function JobStatusBadge({ status }: { status: string }) {
  return <Badge variant={JOB[status] ?? 'outline'}>{humanize(status)}</Badge>;
}

export const runVariant = (status: string): Variant =>
  status === 'COMPLETED'
    ? 'success'
    : status === 'COMPLETED_WITH_ERRORS'
      ? 'warning'
      : status === 'FAILED'
        ? 'destructive'
        : 'secondary';

export function RunStatusBadge({ status }: { status: string }) {
  return <Badge variant={runVariant(status)}>{humanize(status)}</Badge>;
}

/** A score with a bar; colour is redundant with the number, never the only signal. */
export function MatchScore({ score }: { score: number | null }) {
  if (score === null) return <span className="text-muted-foreground">—</span>;
  const tone =
    score >= 75 ? 'bg-emerald-500' : score >= 50 ? 'bg-amber-500' : 'bg-muted-foreground';
  return (
    <div className="flex items-center gap-2" title={`Match score ${score.toFixed(0)} out of 100`}>
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
        <div className={`h-full ${tone}`} style={{ width: `${Math.max(2, score)}%` }} />
      </div>
      <span className="text-xs font-medium tabular-nums">{score.toFixed(0)}</span>
    </div>
  );
}
