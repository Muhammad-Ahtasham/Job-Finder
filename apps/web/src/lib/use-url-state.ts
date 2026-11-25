'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * Table state (page, sort, filters, search) lives in the URL: it survives reloads, is shareable
 * and works with the back button. Values equal to their default are left out of the URL.
 * Changing any filter returns to page 1.
 */
export function useUrlState<T extends Record<string, string>>(defaults: T, prefix = '') {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const paramString = params.toString();

  const state = useMemo(() => {
    const out: Record<string, string> = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const value = params.get(prefix + key);
      if (value !== null) out[key] = value;
    }
    return out as T;
  }, [paramString]);

  const update = useCallback(
    (patch: Partial<T>) => {
      const next = new URLSearchParams(paramString);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === '' || value === defaults[key])
          next.delete(prefix + key);
        else next.set(prefix + key, value as string);
      }
      if (!('page' in patch)) next.delete(`${prefix}page`);
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [paramString, pathname, router],
  );

  const reset = useCallback(() => {
    const next = new URLSearchParams(paramString);
    for (const key of Object.keys(defaults)) next.delete(prefix + key);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [paramString, pathname, router]);
  return { state, update, reset };
}

/** "true" / "false" / "" → a tri-state select value. */
export const TRI_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
] as const;

/** A debounced copy of a value (search boxes). */
export { useDebouncedValue } from './use-debounced-value';
