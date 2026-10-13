import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '../../../components/ui/button';
import { Dialog } from '../../../components/ui/dialog';
import { Textarea } from '../../../components/ui/input';
import type { Verdict } from '../../../lib/types';

/** Same rule as the gateway's ResolveBody: a non-blank note of at most 2000 characters. */
const ResolveForm = z.object({ note: z.string().trim().min(1, 'A note is required').max(2000) });
type ResolveForm = z.infer<typeof ResolveForm>;

export function ResolveDialog({
  verdict,
  onClose,
  onSubmit,
}: {
  verdict: Verdict | null;
  onClose: () => void;
  onSubmit: (v: { verdict: Verdict; note: string }) => void;
}) {
  const form = useForm<ResolveForm>({
    resolver: zodResolver(ResolveForm),
    defaultValues: { note: '' },
  });
  const title = verdict === 'CONFIRMED_FRAUD' ? 'Confirm fraud' : 'Mark legitimate';
  return (
    <Dialog
      open={verdict !== null}
      onOpenChange={(open) => {
        if (!open) {
          form.reset();
          onClose();
        }
      }}
      title={title}
      description="The note is stored in the audit log and sent with the feedback to the anomaly model."
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit(({ note }) => {
          if (!verdict) return;
          onSubmit({ verdict, note });
          form.reset();
          onClose();
        })}
      >
        <Textarea
          label="Note"
          error={form.formState.errors.note?.message}
          {...form.register('note')}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={verdict === 'CONFIRMED_FRAUD' ? 'danger' : 'success'}>
            {title}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
