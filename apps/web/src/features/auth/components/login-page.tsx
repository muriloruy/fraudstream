import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { api, ApiError, unwrap } from '../../../lib/api-client';
import { session } from '../../../lib/session';

/** Same limits as the gateway's LoginBody (SPEC §8.3: shared validation rules). */
const LoginForm = z.object({
  email: z.email('Enter a valid email address').max(254),
  password: z.string().min(1, 'Enter your password').max(256),
});
type LoginForm = z.infer<typeof LoginForm>;

export const LOCKOUT_MESSAGE =
  'This account is locked after too many failed attempts. Try again in 15 minutes.';

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Invalid email or password.';
    if (error.status === 423) return LOCKOUT_MESSAGE;
    if (error.status === 429)
      return 'Too many attempts from this device. Wait a minute and try again.';
  }
  return 'Could not sign in. Check your connection and try again.';
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<LoginForm>({
    resolver: zodResolver(LoginForm),
    defaultValues: { email: '', password: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const body = await unwrap(api.POST('/auth/login', { body: values }));
      session.set(body.accessToken, body.user); // memory only: never web storage
      const from = (location.state as { from?: string } | null)?.from;
      void navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (e) {
      setError(messageFor(e));
      form.resetField('password');
    }
  });

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-1 text-2xl font-semibold text-fg">FraudStream</h1>
        <p className="mb-6 text-sm text-fg-muted">Sign in to the analyst console</p>
        <form
          onSubmit={onSubmit}
          noValidate
          className="flex flex-col gap-4"
          aria-describedby={error ? 'login-error' : undefined}
        >
          <Input
            label="Email"
            type="email"
            autoComplete="username"
            error={errors.email?.message}
            {...form.register('email')}
          />
          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            error={errors.password?.message}
            {...form.register('password')}
          />
          {error ? (
            <p
              id="login-error"
              role="alert"
              className="rounded-md border border-decline/40 bg-decline/10 p-3 text-sm text-decline"
            >
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
