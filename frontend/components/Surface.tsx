'use client';

import { useMemo, useState } from 'react';

import { Canvas } from './Canvas';
import { FileRail } from './FileRail';
import { Wordmark } from './Brand';
import { Theme } from './Theme';

import type { Entry, Gate } from '@/lib/workspace';
import type { IrFlow, IrNode, Projection } from 'treadle';

type Selected = IrNode | IrFlow;

const CHANGE: Record<string, string> = {
  added: 'text-ok',
  removed: 'text-bad',
  rerouted: 'text-warn',
  retyped: 'text-warn',
  renamed: 'text-plot',
  reowned: 'text-plot',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="pt-px text-[12px] text-ink-3">{label}</dt>
      <dd className="min-w-0 text-[13px] break-words">{children}</dd>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-rule px-4 py-4 last:border-b-0">
      <h2 className="mb-2.5 text-[10px] font-semibold tracking-[0.14em] text-ink-3 uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Walk({
  title,
  items,
  onPick,
}: {
  title: string;
  items: { id: string; label: string; note: string }[];
  onPick: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Section title={title}>
      <ul className="-mx-1.5 space-y-px">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onPick(item.id)}
              className="flex w-full items-baseline justify-between gap-3 rounded px-1.5 py-1 text-left text-[13px] hover:bg-sunk"
            >
              <span className="truncate">{item.label}</span>
              {item.note && <span className="shrink-0 text-[11px] text-ink-3">{item.note}</span>}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function Surface({
  path,
  ir,
  gates,
  changed,
  svg,
  packet,
  files,
}: {
  path: string;
  ir: Projection;
  gates: Gate[];
  changed: Record<string, string>;
  svg: string;
  packet: string | null;
  files: Entry[];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(true);

  // Three lookups: a name for anything with an id, the element itself for the things with
  // neighbours worth walking, and a plain description for everything else the drawing lets you
  // click — a pool, a lane, a data object, an annotation.
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of [ir.processes, ir.pools, ir.lanes, ir.groups, ir.data]) {
      for (const item of group ?? []) map.set(item.id, item.name ?? item.id);
    }
    for (const node of ir.nodes ?? []) map.set(node.id, node.name ?? node.id);
    for (const note of ir.notes ?? []) map.set(note.id, note.text ?? note.id);
    for (const flow of [...(ir.flows ?? []), ...(ir.messageFlows ?? [])]) {
      map.set(flow.id, flow.name ?? flow.id);
    }
    return map;
  }, [ir]);

  const selectable = useMemo(() => {
    const map = new Map<string, Selected>();
    for (const node of ir.nodes ?? []) map.set(node.id, node);
    for (const flow of ir.flows ?? []) map.set(flow.id, flow);
    return map;
  }, [ir]);

  const described = useMemo(() => {
    const map = new Map<string, { kind: string; name: string | null }>();
    for (const pool of ir.pools ?? []) map.set(pool.id, { kind: 'pool', name: pool.name });
    for (const lane of ir.lanes ?? []) map.set(lane.id, { kind: 'lane', name: lane.name });
    for (const item of ir.data ?? []) map.set(item.id, { kind: item.kind, name: item.name });
    for (const note of ir.notes ?? []) map.set(note.id, { kind: 'annotation', name: note.text });
    for (const group of ir.groups ?? []) map.set(group.id, { kind: 'group', name: group.name });
    for (const flow of ir.messageFlows ?? []) {
      map.set(flow.id, { kind: 'message flow', name: flow.name });
    }
    for (const link of ir.links ?? []) map.set(link.id, { kind: 'association', name: null });
    return map;
  }, [ir]);

  const nameOf = (id: string | undefined) => (id ? (names.get(id) ?? id) : '');

  const element = selected ? selectable.get(selected) : undefined;
  const other = selected && !element ? described.get(selected) : undefined;
  const flows = ir.flows ?? [];
  const isNode = (value: Selected | undefined): value is IrNode =>
    value !== undefined && 'type' in value;

  const into = element ? flows.filter((flow) => flow.to === element.id) : [];
  const out = element ? flows.filter((flow) => flow.from === element.id) : [];
  const handlers = element ? (ir.nodes ?? []).filter((node) => node.on === element.id) : [];

  const failing = gates.filter((gate) => !gate.ok);
  const kinds = [...new Set(Object.values(changed))].sort();
  const counts = [
    [(ir.nodes ?? []).length, 'nodes'],
    [(ir.pools ?? []).length, 'pools'],
    [(ir.lanes ?? []).length, 'lanes'],
    [(ir.data ?? []).length, 'data'],
  ] as const;

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr] bg-surface">
      <header className="flex items-center gap-3 border-b border-rule px-3 py-2">
        <a href="/" className="rounded px-1 py-0.5 hover:bg-sunk" title="Workspace">
          <Wordmark />
        </a>

        <button
          type="button"
          onClick={() => setRailOpen((open) => !open)}
          aria-pressed={railOpen}
          title="Toggle the process list"
          className="rounded border border-rule px-1.5 py-1 text-ink-3 hover:bg-sunk hover:text-ink"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
            <path d="M6 2.5 V13.5" />
          </svg>
        </button>

        <span className="mx-1 h-4 w-px bg-rule" />

        <b className="truncate font-mono text-[12.5px] font-medium">{path}</b>

        <span
          className={`shrink-0 rounded-full border px-2 py-px text-[10.5px] font-medium tracking-wide ${
            failing.length ? 'border-bad/40 bg-bad/10 text-bad' : 'border-ok/40 bg-ok/10 text-ok'
          }`}
        >
          {failing.length ? `${failing.length} failing` : 'all gates pass'}
        </span>

        {kinds.length > 0 && (
          <span className="hidden shrink-0 items-center gap-2.5 text-[11px] md:flex">
            {kinds.map((kind) => (
              <span key={kind} className={CHANGE[kind]}>
                ● {kind}
              </span>
            ))}
          </span>
        )}

        <span className="ml-auto shrink-0">
          <Theme />
        </span>
      </header>

      <main
        className={`grid min-h-0 max-lg:overflow-y-auto ${
          railOpen ? 'lg:grid-cols-[236px_1fr_344px]' : 'lg:grid-cols-[1fr_344px]'
        }`}
      >
        {railOpen && (
          <nav className="hidden min-h-0 overflow-hidden border-r border-rule lg:block">
            <FileRail files={files} current={path} />
          </nav>
        )}

        <Canvas svg={svg} selected={selected} onSelect={setSelected} />

        <aside className="min-h-0 overflow-y-auto border-t border-rule lg:border-t-0 lg:border-l">
          <Section title="checks">
            <ul className="space-y-1.5">
              {gates.map((gate) => (
                <li key={gate.name} className="flex items-baseline gap-2 text-[12.5px]">
                  <span className={gate.ok ? 'text-ok' : 'text-bad'}>{gate.ok ? '✔' : '✘'}</span>
                  <span className={gate.ok ? 'text-ink-2' : 'text-ink'}>{gate.name}</span>
                  {gate.detail && (
                    <span className="ml-auto truncate text-right text-[11px] text-ink-3">
                      {gate.detail}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-3 tabular-nums">
              {counts
                .filter(([n]) => n > 0)
                .map(([n, label]) => (
                  <span key={label}>
                    <b className="font-medium text-ink-2">{n}</b> {label}
                  </span>
                ))}
            </p>
          </Section>

          {element ? (
            <>
              <Section title="selected">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                  <Row label="id">
                    <code className="font-mono text-[12px]">{element.id}</code>
                  </Row>
                  <Row label="type">{isNode(element) ? element.type : 'flow'}</Row>
                  {element.name ? <Row label="name">{element.name}</Row> : null}
                  {isNode(element) && element.in ? <Row label="in">{nameOf(element.in)}</Row> : null}
                  {isNode(element) && element.lane ? (
                    <Row label="lane">{nameOf(element.lane)}</Row>
                  ) : null}
                  {isNode(element) && element.on ? (
                    <Row label="attached to">{nameOf(element.on)}</Row>
                  ) : null}
                  {isNode(element) && element.event ? (
                    <Row label="event">{[element.event].flat().join(', ')}</Row>
                  ) : null}
                  {!isNode(element) && element.if ? (
                    <Row label="condition">
                      <code className="font-mono text-[12px]">{element.if}</code>
                    </Row>
                  ) : null}
                  {isNode(element) && element.ext ? (
                    <Row label="extensions">
                      <span className="text-[12px] text-ink-3">
                        {[...new Set(element.ext)].join(', ')}
                      </span>
                    </Row>
                  ) : null}
                  {changed[element.id] ? (
                    <Row label="changed">
                      <b className={CHANGE[changed[element.id]]}>{changed[element.id]}</b>
                    </Row>
                  ) : null}
                </dl>
              </Section>

              <Walk
                title="leads in"
                onPick={setSelected}
                items={into.map((flow) => ({
                  id: flow.from,
                  label: nameOf(flow.from),
                  note: flow.name ?? '',
                }))}
              />
              <Walk
                title="leads out"
                onPick={setSelected}
                items={out.map((flow) => ({
                  id: flow.to,
                  label: nameOf(flow.to),
                  note: flow.if ? 'conditional' : (flow.name ?? ''),
                }))}
              />
              <Walk
                title="handlers"
                onPick={setSelected}
                items={handlers.map((handler) => ({
                  id: handler.id,
                  label: handler.name ?? handler.id,
                  note: [handler.event ?? 'plain'].flat().join(','),
                }))}
              />
            </>
          ) : other ? (
            <Section title="selected">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                <Row label="id">
                  <code className="font-mono text-[12px]">{selected}</code>
                </Row>
                <Row label="type">{other.kind}</Row>
                {other.name ? <Row label="name">{other.name}</Row> : null}
                {selected && changed[selected] ? (
                  <Row label="changed">
                    <b className={CHANGE[changed[selected]]}>{changed[selected]}</b>
                  </Row>
                ) : null}
              </dl>
            </Section>
          ) : (
            <>
              {packet && (
                <Section title="what changed">
                  <pre className="overflow-x-auto rounded-md border border-rule bg-paper p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
                    {packet}
                  </pre>
                </Section>
              )}
              <Section title="inspector">
                <p className="text-[12.5px] leading-relaxed text-ink-3">
                  Click anything in the diagram — a task, a flow, a pool, a data object — to see what
                  it is, what leads into it, and what changed about it.
                </p>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px] text-ink-3">
                  <dt>
                    <kbd>Esc</kbd>
                  </dt>
                  <dd>clear the selection</dd>
                  <dt>
                    <kbd>0</kbd>
                  </dt>
                  <dd>fit the diagram</dd>
                  <dt>
                    <kbd>+</kbd> <kbd>−</kbd>
                  </dt>
                  <dd>zoom</dd>
                </dl>
              </Section>
            </>
          )}
        </aside>
      </main>
    </div>
  );
}
