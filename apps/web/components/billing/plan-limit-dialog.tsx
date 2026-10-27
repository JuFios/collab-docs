'use client';

import { planLimitDetailsSchema, roleAtLeast } from '@collab-docs/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { type PlanLimitDetail, onPlanLimitExceeded } from '@/lib/api/plan-limit-events';
import { LIMIT_LABELS, PLAN_LABELS, formatFigure } from '@/lib/billing/format';
import { billingPath } from '@/lib/billing/return';
import { useOptionalWorkspace } from '@/components/workspaces/workspace-provider';

/**
 * The one place a `PLAN_LIMIT_EXCEEDED` ends up, whichever channel it came from: REST mutations reach it through the
 * query client's error handler and Server Actions through `useActionFeedback`; both emit the same event. Admins get a
 * way to the plans, everyone else is told whom to ask. Mounted once per workspace frame (it needs the member's role).
 */
export function PlanLimitDialog() {
  const workspace = useOptionalWorkspace();
  const [detail, setDetail] = useState<PlanLimitDetail | null>(null);

  useEffect(() => onPlanLimitExceeded(setDetail), []);

  const parsed = planLimitDetailsSchema.safeParse(detail?.details);
  const figures = parsed.success ? parsed.data : null;
  const isAdmin = workspace ? roleAtLeast(workspace.role, 'ADMIN') : false;
  const canUpgrade = isAdmin && figures?.plan !== 'TEAM';

  return (
    <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Limit reached</DialogTitle>
          <DialogDescription>
            {figures
              ? `${LIMIT_LABELS[figures.kind]}: ${formatFigure(figures.kind, figures.current)} of ${formatFigure(figures.kind, figures.limit)} used on the ${PLAN_LABELS[figures.plan]} plan.`
              : (detail?.message ?? 'The plan limit of this workspace has been reached.')}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          {canUpgrade
            ? 'Upgrade the plan to get more room, or free some up by removing what you no longer need.'
            : isAdmin
              ? 'This is the largest plan. Free some room up by removing what you no longer need.'
              : 'Ask your workspace admin to upgrade the plan, or free some room up by removing what you no longer need.'}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDetail(null)}>
            {canUpgrade ? 'Not now' : 'Close'}
          </Button>
          {canUpgrade && workspace ? (
            <Button asChild onClick={() => setDetail(null)}>
              <Link href={billingPath(workspace.workspaceId)}>Upgrade plan</Link>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
