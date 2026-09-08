'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { comparisonHref, fileDetails, folders, processHref, selectFiles } from '@/lib/library.mjs';
import type { Sort } from '@/lib/library.mjs';
import type { Entry } from '@/lib/workspace';

const iconPaths = {
  folder: 'M3 7V5h6l2 2h10v12H3Z',
  process: 'M3 10h5v5H3z M16 10h5v5h-5z M8 12.5h8 M12 12.5V5h5',
  search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15 M16 16l5 5',
  compare: 'M5 4v16 M19 4v16 M2 7l3-3 3 3 M16 17l3 3 3-3 M10 9h4 M10 15h4',
  arrow: 'M5 12h14 M14 7l5 5-5 5',
};

function Icon({ name, className = '' }: { name: keyof typeof iconPaths; className?: string }) {
  return (
    <svg className={`h-4 w-4 shrink-0 ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={iconPaths[name]} />
    </svg>
  );
}

/** A library of actual workspace files, with comparison as an explicit two-file operation. */
export function Index({ files, workspace, failed = false }: { files: Entry[]; workspace: string; failed?: boolean }) {
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('name');
  const [comparing, setComparing] = useState(false);
  const [baseline, setBaseline] = useState('');
  const [proposed, setProposed] = useState('');
  const directories = useMemo(() => folders(files), [files]);
  const shown = useMemo(() => selectFiles(files, query, folder, sort), [files, query, folder, sort]);
  const totals = useMemo(() => files.reduce((sum, file) => ({ nodes: sum.nodes + file.nodes, pools: sum.pools + file.pools }), { nodes: 0, pools: 0 }), [files]);
  const compareTo = comparisonHref(files, baseline, proposed);
  const filtered = query !== '' || folder !== null;

  function clearFilters() {
    setQuery('');
    setFolder(null);
  }

  return (
    <div className="library-layout">
      <aside className="library-sidebar" aria-label="Workspace navigation">
        <div className="mb-8 flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-rule bg-surface text-plot"><Icon name="folder" /></span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold tracking-[0.12em] text-ink-2 uppercase">Workspace</p>
            <p className="truncate text-sm font-semibold" title={workspace}>{workspace}</p>
          </div>
        </div>
        <button type="button" className="library-folder" aria-pressed={folder === null} onClick={() => setFolder(null)}>
          <Icon name="process" /><span>All processes</span><span className="ml-auto text-xs tabular-nums">{files.length}</span>
        </button>
        <p className="mt-7 mb-3 px-3 text-[10px] font-semibold tracking-[0.12em] text-ink-2 uppercase">Folders</p>
        <div className="library-folders">
          {directories.map((directory) => (
            <button key={directory.path} type="button" className="library-folder" aria-pressed={folder === directory.path} onClick={() => setFolder(directory.path)} title={directory.path || 'Workspace root'}>
              <Icon name="folder" /><span className="min-w-0 truncate">{directory.path || 'Workspace root'}</span><span className="ml-auto text-xs tabular-nums">{directory.count}</span>
            </button>
          ))}
          {directories.length === 0 && <p className="px-3 text-xs text-ink-2">{failed ? 'Workspace unavailable' : 'No folders with BPMN files'}</p>}
        </div>
        <div className="library-sidebar-note">
          <span className="mb-2 block h-1 w-5 rounded bg-plot" />
          <p className="font-medium text-ink">Your files. Your workspace.</p>
          <p className="mt-1 leading-relaxed">Diagrams are read directly from your local BPMN files.</p>
        </div>
      </aside>

      <main id="main-content" className="library-main">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="mb-2 text-[11px] font-medium text-plot">Process management</p>
            <h1 className="text-[30px] leading-tight font-semibold tracking-[-0.035em] sm:text-[34px]">Process library</h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">Explore your diagrams. Review what changes.</p>
          </div>
          <button type="button" className="library-primary mt-1" disabled={files.length < 2} aria-expanded={comparing} aria-controls="compare-files" onClick={() => setComparing(!comparing)}>
            <Icon name="compare" />Compare files
          </button>
        </div>

        {comparing && (
          <section id="compare-files" aria-labelledby="compare-title" className="mt-6 rounded-xl border border-plot/30 bg-surface p-5">
            <h2 id="compare-title" className="text-sm font-semibold">Compare two versions</h2>
            <p id="compare-description" className="mt-1 text-xs leading-relaxed text-ink-2">Choose the original file and the proposed version of the same process. The review shows what changed between them.</p>
            <div className="mt-4 grid items-end gap-3 lg:grid-cols-[1fr_1fr_auto]">
              <label className="min-w-0 text-xs font-medium">Base version
                <select className="library-select mt-2 w-full" value={baseline} onChange={(event) => setBaseline(event.target.value)} aria-describedby="compare-description">
                  <option value="">Choose original file</option>
                  {files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
                </select>
              </label>
              <label className="min-w-0 text-xs font-medium">Proposed version
                <select className="library-select mt-2 w-full" value={proposed} onChange={(event) => setProposed(event.target.value)} aria-describedby="compare-description compare-feedback">
                  <option value="">Choose proposed file</option>
                  {files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
                </select>
              </label>
              {compareTo ? <Link href={compareTo} prefetch={false} className="library-primary">Open comparison<Icon name="arrow" /></Link> : <button type="button" className="library-primary" disabled>Open comparison<Icon name="arrow" /></button>}
            </div>
            <p id="compare-feedback" role="status" className="mt-3 text-xs text-ink-2">{baseline && baseline === proposed ? 'Choose two different files to compare.' : 'This compares existing files; it does not create a change request or edit either version.'}</p>
          </section>
        )}

        <dl className="library-metrics" aria-label="Workspace overview">
          <div><dt>Processes</dt><dd>{failed ? '—' : files.length}<span>BPMN files</span></dd></div>
          <div><dt>Elements</dt><dd>{failed ? '—' : totals.nodes.toLocaleString('en')}<span>Across all files</span></dd></div>
          <div><dt>Pools</dt><dd>{failed ? '—' : totals.pools.toLocaleString('en')}<span>Participants</span></dd></div>
        </dl>

        <section className="library-collection" aria-labelledby="collection-title">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
            <h2 id="collection-title" className="min-w-0 truncate text-sm font-semibold" title={folder ?? undefined}>{folder === null ? 'All processes' : folder || 'Workspace root'}</h2>
            <span role="status" className="text-xs text-ink-2 tabular-nums">{failed ? 'Unavailable' : `${shown.length} of ${files.length} files`}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3 p-5">
            <div className="relative min-w-0 flex-1 basis-56">
              <Icon name="search" className="pointer-events-none absolute top-3 left-3 text-ink-2" />
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); }} placeholder="Search by name or folder…" aria-label="Search processes" disabled={failed} className="library-search" />
            </div>
            <label className="flex items-center gap-2 text-xs text-ink-2">Sort by
              <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} className="library-select" disabled={failed}>
                <option value="name">Name</option><option value="elements">Most elements</option><option value="size">Largest file</option>
              </select>
            </label>
            {filtered && <button type="button" onClick={clearFilters} className="text-xs font-medium text-plot hover:underline">Clear filters</button>}
          </div>

          {shown.length > 0 ? (
            <table className="library-table">
              <caption className="sr-only">BPMN files in {folder === null ? 'the workspace' : folder || 'the workspace root'}</caption>
              <thead><tr><th scope="col">Process</th><th scope="col">Elements</th><th scope="col" className="library-pools">Pools</th><th scope="col" className="library-size">Size</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
              <tbody>{shown.map((file) => {
                const details = fileDetails(file);
                return (
                  <tr key={file.path}>
                    <td><Link href={processHref(file.path)} prefetch={false} className="library-file" title={file.path}>
                      <span className="library-file-icon"><Icon name="process" /></span>
                      <span className="min-w-0"><span className="block truncate font-medium text-ink">{details.name}</span><span className="mt-1 block truncate text-xs text-ink-2">{details.folder || 'Workspace root'}</span></span>
                    </Link></td>
                    <td className="tabular-nums">{file.nodes}</td><td className="library-pools tabular-nums">{file.pools}</td><td className="library-size tabular-nums">{details.size}</td><td><Icon name="arrow" className="text-ink-2" /></td>
                  </tr>
                );
              })}</tbody>
            </table>
          ) : (
            <div className="px-6 py-16 text-center">
              <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl border border-rule bg-paper text-plot"><Icon name={filtered ? 'search' : 'folder'} /></span>
              <h3 className="text-sm font-semibold">{failed ? 'Could not load your process library' : files.length === 0 ? 'Your workspace starts here' : 'No processes found'}</h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-2">{failed ? 'Check that the workspace is accessible and its BPMN files can be read, then try again.' : files.length === 0 ? 'Add a .bpmn file to your workspace folder, then refresh this page to open its diagram.' : 'Try another name or folder, or clear your filters to see all processes.'}</p>
              {failed || files.length === 0 ? <a href="/" className="mt-5 inline-block text-sm font-medium text-plot hover:underline">{failed ? 'Try again' : 'Refresh library'} →</a> : <button type="button" onClick={clearFilters} className="mt-5 text-sm font-medium text-plot hover:underline">Clear filters</button>}
            </div>
          )}
          <div className="flex items-center gap-2 border-t border-rule px-5 py-3 text-[11px] text-ink-2"><Icon name="process" className="h-3.5 w-3.5" />Open a process to explore its diagram and validation checks.</div>
        </section>
        <p className="mt-5 text-xs leading-relaxed text-ink-2">BPMN 2.0<span className="mx-2" aria-hidden="true">·</span>Original files remain unchanged when browsing or comparing.</p>
      </main>
    </div>
  );
}
