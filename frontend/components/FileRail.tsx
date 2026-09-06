'use client';

import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';

import type { Entry } from '@/lib/workspace';

/**
 * The workspace, always to hand. Reviewing one process almost always means opening the next one,
 * and going back to an index to do it is a step the work does not need.
 */
export function FileRail({ files, current }: { files: Entry[]; current?: string }) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return files;
    return files.filter((file) => file.path.toLowerCase().includes(needle));
  }, [files, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-3 pb-2">
        <div className="relative">
          <input
            ref={search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('');
                search.current?.blur();
              }
            }}
            placeholder="Filter processes"
            aria-label="Filter processes"
            className="w-full rounded-md border border-rule bg-paper py-1.5 pr-3 pl-8 text-[12px] outline-none placeholder:text-ink-3 focus:border-plot"
          />
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-ink-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 L14 14" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      <p className="px-3 pb-2 text-[10px] tracking-[0.14em] text-ink-3 uppercase">
        {shown.length} {shown.length === 1 ? 'process' : 'processes'}
      </p>

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {shown.map((file) => {
          const here = file.path === current;
          const cut = file.path.lastIndexOf('/');
          return (
            <li key={file.path}>
              <Link
                href={`/p/${file.path}`}
                aria-current={here ? 'page' : undefined}
                className={`block rounded-md px-2 py-1.5 ${
                  here ? 'bg-sunk text-ink' : 'text-ink-2 hover:bg-sunk/60'
                }`}
              >
                <span className="block truncate font-mono text-[12px]">
                  {file.path.slice(cut + 1)}
                </span>
                <span className="mt-0.5 flex items-baseline gap-2 text-[10.5px] text-ink-3">
                  {cut > 0 && (
                    <span className="truncate font-mono">{file.path.slice(0, cut)}</span>
                  )}
                  <span className="ml-auto shrink-0 tabular-nums">
                    {file.nodes} · {file.bytes >= 1024 ? `${Math.round(file.bytes / 1024)} kB` : `${file.bytes} B`}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="px-2 py-6 text-center text-[12px] text-ink-3">Nothing matches.</li>
        )}
      </ul>
    </div>
  );
}
