'use client';

import { useEffect, useState } from 'react';

import { THEME_KEY } from '@/lib/theme';

/**
 * Light or dark, chosen by the reader and remembered. The Studio opens light because a diagram is
 * read the way it is printed; the operating system's preference is deliberately not consulted, so
 * a document never changes colour on its own between one visit and the next.
 *
 * The stamp goes on the root element, where `globals.css` reads it. `layout.tsx` sets it before the
 * page paints; this only has to keep the two in step after that.
 */
function stamp(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // A browser that refuses storage still gets the theme for this visit, just not the next one.
  }
}

export function Theme() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  // The server cannot know what was stored, so the button renders light and corrects itself once.
  // This also re-applies the stamp: if the pre-paint script ever fails to run, the page still ends
  // up in the theme the reader chose — a moment late rather than not at all.
  useEffect(() => {
    let stored = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {
      // No storage: this visit is light unless the reader says otherwise.
    }
    const current = stored === 'dark' ? 'dark' : 'light';
    setTheme(current);
    document.documentElement.dataset.theme = current;
  }, []);

  return (
    <button
      type="button"
      aria-label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
      title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
      onClick={() => {
        const next = theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        stamp(next);
      }}
      className="rounded border border-rule px-2 py-0.5 text-[11px] text-ink-3 hover:bg-sunk hover:text-ink"
    >
      {theme === 'dark' ? 'light' : 'dark'}
    </button>
  );
}
