'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { fetchMe } from '@/lib/api';

export default function HomePage() {
  const router = useRouter();
  const { data, isPending } = useQuery({ queryKey: ['me'], queryFn: fetchMe });

  useEffect(() => {
    if (!isPending) router.replace(data ? '/dashboard' : '/login');
  }, [data, isPending, router]);

  return (
    <main className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      Loading…
    </main>
  );
}
