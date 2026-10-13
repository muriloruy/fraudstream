import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { a11yViolations } from '../../test/utils';
import { Badge } from './badge';
import { Button } from './button';
import { Dialog } from './dialog';
import { Input } from './input';
import { Select } from './select';
import { ToastProvider, useToast } from './toast';

describe('Button', () => {
  it('activates with Enter and Space, and is a real button', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Assign</Button>);
    const button = screen.getByRole('button', { name: 'Assign' });
    expect(button).toHaveAttribute('type', 'button');
    button.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

describe('Input', () => {
  it('links the label and announces the error', async () => {
    const { container } = render(<Input label="Email" error="Enter a valid email address" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter a valid email address');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address');
    expect(await a11yViolations(container)).toEqual([]);
  });
});

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title="Confirm fraud">
        <Input label="Note" />
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('traps focus, closes with Escape and returns focus to the trigger', async () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Confirm fraud' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });
});

describe('Select', () => {
  it('is operable with the keyboard', async () => {
    const onChange = vi.fn();
    render(
      <Select
        label="Status"
        value="open"
        onValueChange={onChange}
        options={[
          { value: 'open', label: 'Open' },
          { value: 'resolved', label: 'Resolved' },
        ]}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Status' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeInTheDocument();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('resolved');
  });
});

function ToastHarness() {
  const notify = useToast();
  return (
    <Button
      onClick={() => {
        notify({ title: 'Could not resolve', tone: 'error' });
      }}
    >
      Fail
    </Button>
  );
}

describe('Toast and Badge', () => {
  it('announces toasts and renders accessible badges', async () => {
    const { container } = render(
      <ToastProvider>
        <ToastHarness />
        <Badge tone="decline">DECLINE</Badge>
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Fail' }));
    expect(await screen.findByText('Could not resolve')).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });
});
