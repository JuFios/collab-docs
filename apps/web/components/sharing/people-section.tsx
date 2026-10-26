'use client';

import { SHARE_ROLES, type ShareRole } from '@collab-docs/shared';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  useAddShare,
  useChangeShare,
  useRemoveShare,
  useSetVisibility,
  useShares,
} from '@/lib/sharing/queries';

const ROLE_LABEL: Record<ShareRole, string> = { VIEWER: 'Can view', EDITOR: 'Can edit' };

/** Who can open the document inside the workspace: everyone, or only the people added here. */
export function PeopleSection({
  documentId,
  visibility,
  enabled,
}: {
  documentId: string;
  visibility: 'WORKSPACE' | 'RESTRICTED';
  enabled: boolean;
}) {
  const shares = useShares(documentId, enabled);
  const add = useAddShare(documentId);
  const change = useChangeShare(documentId);
  const remove = useRemoveShare(documentId);
  const setVisibility = useSetVisibility(documentId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ShareRole>('VIEWER');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate({ email: email.trim(), role }, { onSuccess: () => setEmail('') });
  };

  return (
    <section aria-labelledby="share-people" className="grid gap-3">
      <h3 id="share-people" className="text-sm font-medium">
        People
      </h3>
      <div className="grid gap-1">
        <Label htmlFor="share-visibility">Who can open this document</Label>
        <Select
          id="share-visibility"
          value={visibility}
          disabled={setVisibility.isPending}
          onChange={(event) =>
            setVisibility.mutate(event.target.value as 'WORKSPACE' | 'RESTRICTED')
          }
        >
          <option value="WORKSPACE">Everyone in the workspace</option>
          <option value="RESTRICTED">Only people added below</option>
        </Select>
      </div>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-48 flex-1 gap-1">
          <Label htmlFor="share-email">Add a person</Label>
          <Input
            id="share-email"
            type="email"
            required
            placeholder="name@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <Select
          aria-label="Role of the new person"
          className="w-32"
          value={role}
          onChange={(event) => setRole(event.target.value as ShareRole)}
        >
          {SHARE_ROLES.map((value) => (
            <option key={value} value={value}>
              {ROLE_LABEL[value]}
            </option>
          ))}
        </Select>
        <Button type="submit" disabled={add.isPending}>
          Add
        </Button>
      </form>
      {shares.data?.length ? (
        <ul aria-label="People with access" className="grid gap-2">
          {shares.data.map((share) => (
            <li key={share.userId} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {share.name} <span className="text-muted-foreground">{share.email}</span>
              </span>
              <Select
                aria-label={`Role of ${share.email}`}
                className="w-32"
                value={share.role}
                onChange={(event) =>
                  change.mutate({ userId: share.userId, role: event.target.value as ShareRole })
                }
              >
                {SHARE_ROLES.map((value) => (
                  <option key={value} value={value}>
                    {ROLE_LABEL[value]}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${share.email}`}
                onClick={() => remove.mutate(share.userId)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
