'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { copyText } from '@/lib/clipboard';

/** A read-only value with a copy button (the address of a page or an edit link). */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <Input readOnly aria-label={label} value={value} onFocus={(event) => event.target.select()} />
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          void copyText(value).then((ok) => {
            if (!ok) return toast.error('Could not copy the link');
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? (
          <Check className="h-4 w-4" aria-hidden />
        ) : (
          <Copy className="h-4 w-4" aria-hidden />
        )}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}
