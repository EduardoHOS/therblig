/** @typedef {import('./workspace').Entry} Entry */
/** @typedef {'name' | 'elements' | 'size'} Sort */

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** @param {Entry} file */
export function fileDetails(file) {
  const cut = file.path.lastIndexOf('/');
  return {
    name: file.path.slice(cut + 1),
    folder: file.path.slice(0, Math.max(0, cut)),
    size: file.bytes >= 1024 ? `${Math.round(file.bytes / 1024)} kB` : `${file.bytes} B`,
  };
}

/** Direct containing directories; the empty path is the workspace root. @param {Entry[]} files */
export function folders(files) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const file of files) {
    const { folder } = fileDetails(file);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => collator.compare(a, b)).map(([path, count]) => ({ path, count }));
}

/** @param {string} value */
const searchable = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Null selects the whole workspace; '' selects only its root files.
 * @param {Entry[]} files
 * @param {string} query
 * @param {string | null} folder
 * @param {Sort} sort
 */
export function selectFiles(files, query, folder, sort) {
  const needle = searchable(query.trim());
  return files
    .filter((file) => (folder === null || fileDetails(file).folder === folder) && searchable(file.path).includes(needle))
    .sort((a, b) => {
      const byName = collator.compare(fileDetails(a).name, fileDetails(b).name) || collator.compare(a.path, b.path);
      if (sort === 'elements') return b.nodes - a.nodes || byName;
      if (sort === 'size') return b.bytes - a.bytes || byName;
      return byName;
    });
}

/** Encode each segment once, matching the process page's route decoding. @param {string} path */
export function processHref(path) {
  return `/p/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** @param {Entry[]} files @param {string} baseline @param {string} proposed */
export function comparisonHref(files, baseline, proposed) {
  if (baseline === proposed || !files.some((file) => file.path === baseline) || !files.some((file) => file.path === proposed)) return null;
  return `${processHref(proposed)}?${new URLSearchParams({ against: baseline })}`;
}
