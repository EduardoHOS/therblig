'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import type { Entry } from '@/lib/workspace';

const size = (bytes: number) => (bytes >= 1024 ? `${Math.round(bytes / 1024)} kB` : `${bytes} B`);

/** The workspace as a list you can narrow. Grouped by directory, because a corpus has shape. */
export function Index({ files }: { files: Entry[] }) {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const shown = needle ? files.filter((f) => f.path.toLowerCase().includes(needle)) : files;
    const byFolder = new Map<string, Entry[]>();
    for (const file of shown) {
      const cut = file.path.lastIndexOf('/');
      const folder = cut > 0 ? file.path.slice(0, cut) : '';
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
    }
    return [...byFolder];
  }, [files, query]);

  const found = groups.reduce((sum, [, entries]) => sum + entries.length, 0);

  return (
    <div className="mt-10">
      <div className="flex items-baseline justify-between gap-4">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by name or folder"
          aria-label="Filter processes"
          className="w-full max-w-sm rounded-md border border-rule bg-surface px-3 py-1.5 text-[13px] outline-none placeholder:text-ink-3 focus:border-plot"
        />
        <span className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">
          {found} of {files.length}
        </span>
      </div>

      {groups.map(([folder, entries]) => (
        <section key={folder} className="mt-7">
          <h2 className="mb-2 font-mono text-[11px] tracking-wide text-ink-3">{folder || './'}</h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {entries.map((file) => (
              <li key={file.path}>
                <Link
                  href={`/p/${file.path}`}
                  className="group block rounded-lg border border-rule bg-surface px-3.5 py-3 transition-colors hover:border-plot/50 hover:bg-sunk/50"
                >
                  <span className="block truncate font-mono text-[13px] group-hover:text-plot">
                    {file.path.slice(folder ? folder.length + 1 : 0)}
                  </span>
                  <span className="mt-1.5 flex gap-3 text-[11px] text-ink-3 tabular-nums">
                    <span>{file.nodes} elements</span>
                    {file.pools > 0 && (
                      <span>
                        {file.pools} {file.pools === 1 ? 'pool' : 'pools'}
                      </span>
                    )}
                    <span className="ml-auto">{size(file.bytes)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {found === 0 && (
        <p className="mt-10 text-center text-[13px] text-ink-3">Nothing matches “{query}”.</p>
      )}
    </div>
  );
}
