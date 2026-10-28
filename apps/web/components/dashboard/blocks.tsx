import Link from 'next/link';
import { roleAtLeast, type Usage, type WorkspaceRole } from '@collab-docs/shared';
import { dashboardDelay } from '@/lib/dashboard/delay';
import {
  getMembers,
  getRecentDocuments,
  getSharedDocuments,
  getUsage,
} from '@/lib/workspaces/data';
import { formatBytes, formatRelative, ROLE_LABELS } from '@/lib/workspaces/labels';

const EMPTY = 'text-sm text-muted-foreground';

export async function RecentDocumentsBlock({ workspaceId }: { workspaceId: string }) {
  await dashboardDelay();
  const documents = await getRecentDocuments(workspaceId, 6);
  if (documents.length === 0) {
    return <p className={EMPTY}>No documents yet. Pages you create will show up here.</p>;
  }
  return (
    <ul className="divide-y">
      {documents.map((document) => (
        <li key={document.id}>
          <Link
            href={`/workspaces/${workspaceId}/documents/${document.id}`}
            className="flex items-center justify-between gap-3 py-2 text-sm hover:underline"
          >
            <span className="truncate">
              <span aria-hidden>{document.icon ?? '📄'}</span> {document.title || 'Untitled'}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatRelative(document.updatedAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export async function MembersBlock({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: WorkspaceRole;
}) {
  await dashboardDelay();
  const members = await getMembers(workspaceId);
  const shown = members.slice(0, 5);
  return (
    <div className="grid gap-3">
      <ul className="divide-y">
        {shown.map((member) => (
          <li key={member.userId} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="truncate">{member.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {ROLE_LABELS[member.role]}
            </span>
          </li>
        ))}
      </ul>
      <p className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {members.length} {members.length === 1 ? 'member' : 'members'}
        </span>
        {roleAtLeast(role, 'ADMIN') ? (
          <Link
            className="underline underline-offset-4"
            href={`/workspaces/${workspaceId}/settings`}
          >
            Manage members
          </Link>
        ) : null}
      </p>
    </div>
  );
}

function Meter({
  label,
  text,
  value,
  max,
}: {
  label: string;
  text: string;
  value: number;
  max: number | null;
}) {
  const percent = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="grid gap-1">
      <div className="flex justify-between text-xs">
        <span>{label}</span>
        <span className="text-muted-foreground">{text}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max ?? undefined}
        aria-valuenow={max ? value : undefined}
        aria-valuetext={text}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={percent >= 100 ? 'h-full bg-destructive' : 'h-full bg-primary'}
          style={{ width: max ? `${percent}%` : '0%' }}
        />
      </div>
    </div>
  );
}

function usageRows(usage: Usage) {
  const slots = usage.members.current + usage.members.pendingInvites;
  return {
    members: {
      text: `${slots} of ${usage.members.limit}${usage.members.pendingInvites ? ` (${usage.members.pendingInvites} pending)` : ''}`,
      value: slots,
      max: usage.members.limit,
    },
    documents: {
      text:
        usage.documents.limit === null
          ? `${usage.documents.current} (unlimited)`
          : `${usage.documents.current} of ${usage.documents.limit}`,
      value: usage.documents.current,
      max: usage.documents.limit,
    },
    storage: {
      text: `${formatBytes(usage.storage.currentBytes)} of ${formatBytes(usage.storage.limitBytes)}`,
      value: usage.storage.currentBytes,
      max: usage.storage.limitBytes,
    },
  };
}

const PLAN_NAMES = { FREE: 'Free', PRO: 'Pro', TEAM: 'Team' } as const;

export async function UsageBlock({ workspaceId }: { workspaceId: string }) {
  await dashboardDelay();
  const usage = await getUsage(workspaceId);
  const rows = usageRows(usage);
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        <span className="font-medium">{PLAN_NAMES[usage.plan]}</span> plan
      </p>
      <Meter label="Members" {...rows.members} />
      <Meter label="Documents" {...rows.documents} />
      <Meter label="Storage" {...rows.storage} />
    </div>
  );
}

export async function SharedWithMeBlock({ workspaceId }: { workspaceId: string }) {
  await dashboardDelay();
  const shared = (await getSharedDocuments()).filter((doc) => doc.workspaceId === workspaceId);
  if (shared.length === 0) {
    return <p className={EMPTY}>Nothing has been shared with you in this workspace.</p>;
  }
  return (
    <ul className="divide-y">
      {shared.map((doc) => (
        <li key={doc.id}>
          <Link
            href={`/workspaces/${workspaceId}/documents/${doc.id}`}
            className="flex items-center justify-between gap-3 py-2 text-sm hover:underline"
          >
            <span className="truncate">
              <span aria-hidden>{doc.icon ?? '📄'}</span> {doc.title || 'Untitled'}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {doc.role === 'EDITOR' ? 'Can edit' : 'Can view'}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
