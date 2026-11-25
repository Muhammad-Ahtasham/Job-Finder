'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { TRI_OPTIONS } from '@/lib/use-url-state';
import { useDebouncedValue } from '@/lib/use-debounced-value';

export function FilterField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Search box: types freely, updates the URL (and so the query) once typing pauses. */
export function SearchBox({
  id,
  value,
  onChange,
  placeholder,
  label = 'Search',
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label?: string;
}) {
  const [draft, setDraft] = useState(value);
  const debounced = useDebouncedValue(draft, 350);

  // URL → box (back button, reset).
  useEffect(() => setDraft(value), [value]);
  // box → URL
  useEffect(() => {
    if (debounced !== value) onChange(debounced.trim());
  }, [debounced]);

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        id={id}
        type="search"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="pl-9"
        maxLength={100}
      />
    </div>
  );
}

export function TriSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {TRI_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

export function OptionSelect({
  id,
  value,
  onChange,
  options,
  anyLabel = 'Any',
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  anyLabel?: string;
}) {
  const known = options.some((o) => o.value === value);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{anyLabel}</option>
      {/* keep a value from the URL selectable even if it is not (yet) in the options */}
      {value && !known && <option value={value}>{value}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

export function FilterBar({
  children,
  activeCount,
  onReset,
}: {
  children: ReactNode;
  activeCount: number;
  onReset: () => void;
}) {
  return (
    <form
      role="search"
      aria-label="Filters"
      onSubmit={(e) => e.preventDefault()}
      className="flex flex-col gap-3 border-b p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
      {activeCount > 0 && (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={onReset}>
            <X className="size-3.5" aria-hidden="true" />
            Clear {activeCount} filter{activeCount === 1 ? '' : 's'}
          </Button>
        </div>
      )}
    </form>
  );
}
