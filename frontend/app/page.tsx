import { Mark } from '@/components/Brand';
import { Index } from '@/components/Index';
import { Theme } from '@/components/Theme';
import { ROOT, list } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const files = await list();
  const totals = files.reduce(
    (sum, file) => ({ nodes: sum.nodes + file.nodes, pools: sum.pools + file.pools }),
    { nodes: 0, pools: 0 },
  );

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-rule bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-2.5">
          <Mark className="h-[18px] w-[18px] text-plot" />
          <span className="text-[13px] font-semibold tracking-tight">
            Treadle<span className="text-ink-3"> Studio</span>
          </span>
          <span className="ml-auto">
            <Theme />
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-14">
        <h1 className="max-w-2xl text-[34px] leading-[1.15] font-semibold tracking-[-0.02em]">
          The processes in your workspace, and what an agent proposed changing about them.
        </h1>
        <p className="mt-4 max-w-prose text-[15px] leading-relaxed text-ink-2">
          A review surface, not a modeller. Every diagram is drawn from the coordinates the file
          already carries, every check is run before you look, and nothing leaves this machine.
        </p>

        <dl className="mt-8 flex flex-wrap items-baseline gap-x-8 gap-y-3 border-y border-rule py-4">
          {[
            [files.length, files.length === 1 ? 'process' : 'processes'],
            [totals.nodes, 'elements'],
            [totals.pools, totals.pools === 1 ? 'pool' : 'pools'],
          ].map(([value, label]) => (
            <div key={label as string} className="flex items-baseline gap-2">
              <dt className="text-[22px] font-semibold tracking-tight tabular-nums">{value}</dt>
              <dd className="text-[12px] text-ink-3">{label}</dd>
            </div>
          ))}
          <p className="ml-auto truncate font-mono text-[11.5px] text-ink-3" title={ROOT}>
            {ROOT}
          </p>
        </dl>

        {files.length === 0 ? (
          <div className="mt-10 rounded-lg border border-dashed border-rule px-6 py-14 text-center">
            <p className="text-[15px] font-medium">No BPMN files in this workspace.</p>
            <p className="mx-auto mt-2 max-w-sm text-[13px] text-ink-3">
              Point <code className="font-mono">TREADLE_WORKSPACE</code> at a directory that has
              some, or drop a <code className="font-mono">.bpmn</code> file into this one.
            </p>
          </div>
        ) : (
          <Index files={files} />
        )}

        <p className="mt-10 max-w-prose text-[12.5px] leading-relaxed text-ink-3">
          Reviewing a proposal? Add <code className="font-mono text-ink-2">?against=other.bpmn</code>{' '}
          to a file&rsquo;s URL. The diagram is coloured by what changed — green for added, amber for
          rerouted, teal for renamed — and the review packet appears beside it.
        </p>
      </div>
    </div>
  );
}
