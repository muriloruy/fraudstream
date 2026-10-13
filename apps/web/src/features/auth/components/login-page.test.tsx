import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { session } from '../../../lib/session';
import { analyst, json, mockFetch, on, problem, renderAt } from '../../../test/utils';
import { LOCKOUT_MESSAGE, LoginPage } from './login-page';
import { RequireAuth } from './require-auth';

afterEach(() => {
  session.clear();
});

const fill = async (email: string, password: string) => {
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
};

describe('Login (SPEC §8.2)', () => {
  it('validates fields before sending anything', async () => {
    const { fn } = mockFetch();
    renderAt(<LoginPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
    expect(fn).not.toHaveBeenCalled();
  });

  it('shows the lockout message when the gateway reports a locked account', async () => {
    mockFetch(on('POST', '/auth/login', () => problem(423, 'Locked')));
    renderAt(<LoginPage />);
    await fill('analyst@demo.local', 'whatever');
    expect(await screen.findByRole('alert')).toHaveTextContent(LOCKOUT_MESSAGE);
  });

  it('shows a generic error for wrong credentials and clears the password', async () => {
    mockFetch(on('POST', '/auth/login', () => problem(401, 'Unauthorized')));
    renderAt(<LoginPage />);
    await fill('analyst@demo.local', 'wrong');
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('keeps the access token in memory only, never in web storage', async () => {
    mockFetch(
      on('POST', '/auth/login', () =>
        json({
          accessToken: 'secret-access-token',
          tokenType: 'Bearer',
          expiresIn: 900,
          user: analyst,
        }),
      ),
    );
    const { router } = renderAt(<LoginPage />, '/login', '/login');
    await fill('analyst@demo.local', 'correct horse');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expect(session.token).toBe('secret-access-token');
    const dump = (storage: Storage) =>
      Array.from(
        { length: storage.length },
        (_, i) => `${storage.key(i) ?? ''}=${storage.getItem(storage.key(i) ?? '') ?? ''}`,
      ).join(';');
    const stored = dump(localStorage) + dump(sessionStorage);
    expect(stored).not.toContain('secret-access-token');
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });
});

describe('page reload', () => {
  it('restores the session from the refresh cookie', async () => {
    mockFetch(
      on('POST', '/auth/refresh', () =>
        json({ accessToken: 'fresh', tokenType: 'Bearer', expiresIn: 900, user: analyst }),
      ),
    );
    renderAt(
      <RequireAuth>
        <p>inside the app</p>
      </RequireAuth>,
    );
    expect(await screen.findByText('inside the app')).toBeInTheDocument();
    expect(session.principal?.email).toBe(analyst.email);
  });

  it('goes to login when the refresh cookie is gone', async () => {
    mockFetch(on('POST', '/auth/refresh', () => problem(401, 'Unauthorized')));
    const { router } = renderAt(
      <RequireAuth>
        <p>inside the app</p>
      </RequireAuth>,
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
  });
});
