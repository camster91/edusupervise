// apps/web/app/components/CopyableJoinCode.tsx
//
// Admin's "share with teachers" panel. Shows the school join code in
// monospace + two buttons:
//   - "Copy code" — copies just the code (e.g. SUNRISE-43) to clipboard
//   - "Copy invite link" — copies the full URL with ?school=CODE preset
//
// Copy feedback is a small inline "Copied!" pill that auto-clears.

import { useState } from 'react';
import { Copy, Link as LinkIcon, Check } from 'lucide-react';

export interface CopyableJoinCodeProps {
  joinCode: string;
}

export function CopyableJoinCode({ joinCode }: CopyableJoinCodeProps): React.ReactElement {
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://edusupervise.ashbi.ca';
  const inviteUrl = `${origin}/signup?school=${encodeURIComponent(joinCode)}`;

  async function copy(text: string, kind: 'code' | 'link') {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      // Fallback: select-and-prompt
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(kind);
        window.setTimeout(() => setCopied(null), 1800);
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  return (
    <section className="bg-surface border border-border rounded-xl p-xl">
      <h3 className="text-title-3 text-primary font-semibold mb-sm">
        School join code
      </h3>
      <p className="text-callout text-secondary mb-md">
        Share this code with your teachers. They'll type it at <code>/signup</code>{' '}
        to join your school. Anyone with the code can join — don't post it publicly.
      </p>

      <div className="flex items-center gap-md">
        <code className="flex-1 min-w-0 text-title-3 text-primary font-mono font-semibold tracking-wide bg-bg border border-border rounded-md px-md py-sm text-center select-all">
          {joinCode}
        </code>
        <button
          type="button"
          onClick={() => copy(joinCode, 'code')}
          className="inline-flex items-center gap-xs h-btn-md px-md rounded-md font-semibold bg-accent text-on-accent hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-colors duration-fast"
        >
          {copied === 'code' ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
          {copied === 'code' ? 'Copied' : 'Copy code'}
        </button>
      </div>

      <button
        type="button"
        onClick={() => copy(inviteUrl, 'link')}
        className="mt-md inline-flex items-center gap-xs h-btn-sm px-md rounded-md font-medium bg-surface-2 text-primary border border-border hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 transition-colors duration-fast"
      >
        {copied === 'link' ? <Check size={14} aria-hidden /> : <LinkIcon size={14} aria-hidden />}
        {copied === 'link' ? 'Link copied' : 'Copy invite link'}
      </button>

      <p className="text-footnote text-secondary mt-md break-all">
        {inviteUrl}
      </p>
    </section>
  );
}