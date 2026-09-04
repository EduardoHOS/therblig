// Kill criterion 1, and the input to ADR-004's comment policy.
//
// F10 measured that a moddle round-trip drops XML comments, DOCTYPE and processing
// instructions silently. Corpus incidence was 1 of 22, in header position — an
// exporter banner, cosmetically lossless. That number cannot decide the policy,
// because the MIWG corpus is 21 reference models written by tool vendors, not files
// written by the people we are asking to trust us with theirs.
//
// The deciding question is narrow: how often does a real .bpmn carry a comment in a
// BODY position — inside the document, where it is a human annotation rather than a
// generator banner? Header banners are noise. Body comments are somebody's
// "<!-- reviewed by legal 2026-03 -->" and losing one in a commit they did not intend
// is the kind of thing that ends trust in a preservation tool permanently.
//
// Decision rule, pre-registered in the plan:
//   body-position incidence > ~15%  -> build the byte-level comment splice (+5 days)
//                            > ~5%  -> build the header/footer splice only
//                            <= 5%  -> warn and proceed (ADR-004 clause 2 as written)
//
// NETWORK + AUTH REQUIRED. Not run in CI. Needs `gh auth status` to be green.
// Results are written to bench/probe/comment-incidence.json so the number is citable
// without re-running, and re-runnable by anyone with a GitHub account.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const TARGET = Number(process.argv[2] || 200);
const MAX_PER_REPO = 3;          // one vendor's fixture directory must not dominate
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Diversified queries. Relevance ranking is heavily repo-clustered, so a single query
// would sample one corner of GitHub. Each term targets a different exporter/ecosystem.
const QUERIES = [
  'bpmndi in:file extension:bpmn',
  'camunda in:file extension:bpmn',
  'zeebe in:file extension:bpmn',
  'flowable in:file extension:bpmn',
  'activiti in:file extension:bpmn',
  'signavio in:file extension:bpmn',
  'collaboration in:file extension:bpmn',
  'userTask in:file extension:bpmn',
];

function search(q, page) {
  const out = execFileSync('gh', [
    'api', '-X', 'GET', 'search/code',
    '-f', `q=${q}`, '-F', 'per_page=100', '-F', `page=${page}`,
    '--jq', '.items[] | [.repository.full_name, .path, .url] | @tsv',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [repo, path, url] = l.split('\t');
    return { repo, path, url };
  });
}

// Collect candidates, capped per repo.
const perRepo = new Map();
const picked = [];
outer: for (const q of QUERIES) {
  for (let page = 1; page <= 2; page++) {
    let rows = [];
    try { rows = search(q, page); }
    catch (e) { console.error(`  query failed (${q} p${page}): ${String(e.message).slice(0, 80)}`); break; }
    for (const r of rows) {
      const n = perRepo.get(r.repo) || 0;
      if (n >= MAX_PER_REPO) continue;
      perRepo.set(r.repo, n + 1);
      picked.push(r);
      if (picked.length >= TARGET) break outer;
    }
    await sleep(6500);                    // code search is ~10 req/min authenticated
  }
}
console.log(`selected ${picked.length} files across ${perRepo.size} repositories\n`);

// Fetch content through the contents API (base64) — raw.githubusercontent needs a ref.
async function content(url) {
  const out = execFileSync('gh', ['api', url, '--jq', '.content'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return Buffer.from(out.replace(/\s/g, ''), 'base64').toString('utf8');
}

const stats = {
  fetched: 0, failed: 0,
  withComment: 0, headerOnly: 0, withBodyComment: 0,
  withDoctype: 0, withPI: 0,
  bodyExamples: [],
};

for (const f of picked) {
  let xml;
  try { xml = await content(f.url); stats.fetched++; }
  catch { stats.failed++; continue; }

  const comments = [...xml.matchAll(/<!--[\s\S]*?-->/g)];
  const doctype = /<!DOCTYPE/i.test(xml);
  const pis = [...xml.matchAll(/<\?[\s\S]*?\?>/g)].filter((m) => !/^<\?xml\s/i.test(m[0]));
  if (doctype) stats.withDoctype++;
  if (pis.length) stats.withPI++;
  if (!comments.length) continue;

  stats.withComment++;
  const rootAt = xml.search(/<(?:\w+:)?definitions[\s>]/);
  const body = comments.filter((m) => rootAt >= 0 && m.index > rootAt);
  if (!body.length) { stats.headerOnly++; continue; }

  stats.withBodyComment++;
  if (stats.bodyExamples.length < 12) {
    stats.bodyExamples.push({
      repo: f.repo, path: f.path,
      sample: body[0][0].replace(/\s+/g, ' ').slice(0, 100),
    });
  }
}

const pct = (n) => stats.fetched ? ((n / stats.fetched) * 100).toFixed(1) + '%' : 'n/a';
console.log(`fetched                       ${stats.fetched} (${stats.failed} failed)`);
console.log(`carrying any comment          ${stats.withComment}  ${pct(stats.withComment)}`);
console.log(`  header/banner only          ${stats.headerOnly}  ${pct(stats.headerOnly)}`);
console.log(`  AT LEAST ONE BODY COMMENT   ${stats.withBodyComment}  ${pct(stats.withBodyComment)}   <-- the decision number`);
console.log(`carrying a DOCTYPE            ${stats.withDoctype}  ${pct(stats.withDoctype)}`);
console.log(`carrying a non-decl PI        ${stats.withPI}  ${pct(stats.withPI)}`);

if (stats.bodyExamples.length) {
  console.log('\nbody-position examples:');
  for (const e of stats.bodyExamples) console.log(`  ${e.repo}/${e.path}\n    ${e.sample}`);
}

// A policy verdict from a small or empty sample is precisely the failure mode F11
// documents: an instrument reporting success because it measured nothing. The first
// run of this probe fetched 0 files and printed "WARN AND PROCEED". Refuse instead.
const MIN_SAMPLE = 100;
if (stats.fetched < MIN_SAMPLE) {
  console.log(`
INSUFFICIENT SAMPLE: ${stats.fetched} files fetched, need >= ${MIN_SAMPLE}.`);
  console.log('No verdict. Check `gh auth status` and the search-API rate limit, then re-run.');
  writeFileSync('bench/probe/comment-incidence.json', JSON.stringify({
    measured: '2026-09-04', insufficientSample: true, ...stats,
  }, null, 2) + '\n');
  process.exit(1);
}

const rate = stats.withBodyComment / stats.fetched;
const verdict = rate > 0.15 ? 'BYTE-LEVEL SPLICE REQUIRED (kill criterion 1 fires)'
  : rate > 0.05 ? 'HEADER/FOOTER SPLICE (ADR-004 contingency)'
  : 'WARN AND PROCEED (ADR-004 clause 2 as written)';
console.log(`\nbody-comment incidence ${(rate * 100).toFixed(1)}%  ->  ${verdict}`);

writeFileSync('bench/probe/comment-incidence.json', JSON.stringify({
  measured: '2026-09-04', target: TARGET, maxPerRepo: MAX_PER_REPO,
  queries: QUERIES, repositories: perRepo.size, ...stats, rate, verdict,
}, null, 2) + '\n');
console.log('\nwritten: bench/probe/comment-incidence.json');
