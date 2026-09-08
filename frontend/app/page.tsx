import { basename } from 'node:path';

import { Wordmark } from '@/components/Brand';
import { Index } from '@/components/Index';
import { Theme } from '@/components/Theme';
import { ROOT, list } from '@/lib/workspace';
import type { Entry } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export default async function Home() {
  let files: Entry[] = [];
  let failed = false;
  try {
    files = await list();
  } catch (error) {
    console.error('[studio] Cannot list workspace', error);
    failed = true;
  }

  return (
    <div className="library-home min-h-dvh">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-20 focus:bg-surface focus:p-3">Skip to process library</a>
      <header className="library-header">
        <Wordmark />
        <span className="mx-4 hidden text-rule sm:inline" aria-hidden="true">/</span>
        <span className="hidden text-xs font-medium text-ink-2 sm:inline">Processes</span>
        <div className="ml-auto flex items-center gap-4">
          <span className="hidden items-center gap-2 text-xs text-ink-2 sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-plot" />Local workspace</span>
          <Theme />
        </div>
      </header>
      <Index files={files} workspace={basename(ROOT) || ROOT} failed={failed} />
    </div>
  );
}
