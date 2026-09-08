import Link from 'next/link';

import { Wordmark } from '@/components/Brand';
import { Surface } from '@/components/Surface';
import { list, open } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export default async function Process({
  params,
  searchParams,
}: {
  params: Promise<{ file: string[] }>;
  searchParams: Promise<{ against?: string }>;
}) {
  const { file } = await params;
  const { against } = await searchParams;
  const path = file.map(decodeURIComponent).join('/');

  // The rail is part of the shell, so the workspace is listed alongside whatever is being reviewed.
  const files = await list();

  try {
    const opened = await open(path, against);
    return <Surface {...opened} files={files} />;
  } catch (error) {
    // A path outside the workspace, a file that is not there, or one that does not parse. The
    // reason is the useful part, and a stack is not.
    return (
      <div className="grid h-dvh grid-rows-[auto_1fr]">
        <header className="flex items-center border-b border-rule px-3 py-2">
          <Link href="/" className="rounded px-1 py-0.5 hover:bg-sunk">
            <Wordmark />
          </Link>
        </header>
        <div className="mx-auto w-full max-w-xl px-6 py-24">
          <h1 className="text-xl font-semibold tracking-tight">Cannot open {path}</h1>
          <p className="mt-3 rounded-md border border-bad/30 bg-bad/5 px-3 py-2 font-mono text-[12px] text-bad">
            {(error as Error).message}
          </p>
          <Link href="/" className="mt-6 inline-block text-[13px] text-plot hover:underline">
            ← back to the workspace
          </Link>
        </div>
      </div>
    );
  }
}
