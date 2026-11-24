'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  loginRequestSchema,
  PASSWORD_MIN_LENGTH,
  registerRequestSchema,
} from '@jobfinder/contracts';
import { login, register } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Mode = 'login' | 'register';

const copy = {
  login: {
    title: 'Sign in',
    description: 'Welcome back to Job Intelligence.',
    submit: 'Sign in',
    alt: { text: "Don't have an account?", href: '/register', label: 'Create one' },
  },
  register: {
    title: 'Create your account',
    description: 'A personal workspace is created for you automatically.',
    submit: 'Create account',
    alt: { text: 'Already registered?', href: '/login', label: 'Sign in' },
  },
} as const;

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (form: FormData) => {
      const raw = Object.fromEntries(form) as Record<string, string>;
      // Client-side parsing is only for fast feedback; the API re-validates everything.
      if (mode === 'login') {
        return login(loginRequestSchema.parse({ email: raw.email, password: raw.password }));
      }
      return register(
        registerRequestSchema.parse({ email: raw.email, password: raw.password, name: raw.name }),
      );
    },
    onSuccess: (me) => {
      queryClient.setQueryData(['me'], me);
      router.replace('/dashboard');
    },
    onError: (err: unknown) => {
      if (err && typeof err === 'object' && 'issues' in err) {
        const issues = (err as { issues: { message: string }[] }).issues;
        setError(issues.map((i) => i.message).join('. '));
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong');
      }
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    mutation.mutate(new FormData(event.currentTarget));
  };

  const text = copy[mode];

  return (
    <Card className="w-full max-w-sm">
      <form onSubmit={onSubmit} noValidate>
        <CardHeader>
          <CardTitle className="text-xl">{text.title}</CardTitle>
          <CardDescription>{text.description}</CardDescription>
        </CardHeader>
        <CardContent className="mt-6 flex flex-col gap-4">
          {mode === 'register' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" autoComplete="name" required />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
            />
            {mode === 'register' && (
              <p className="text-xs text-muted-foreground">
                At least {PASSWORD_MIN_LENGTH} characters.
              </p>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="mt-6 flex-col items-stretch gap-3">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Please wait…' : text.submit}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            {text.alt.text}{' '}
            <Link
              href={text.alt.href}
              className="font-medium text-foreground underline underline-offset-4"
            >
              {text.alt.label}
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
