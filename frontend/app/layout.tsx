import type { Metadata } from 'next';
import './globals.css';

import { THEME_KEY } from '@/lib/theme';

// Stamped before the first paint, or a reader who chose dark sees the light page flash first. Only
// dark is ever written: light is the default, and the absence of a stamp is what says so.
//
// It sits at the top of the body rather than in the head: React hoists and dedupes what it finds in
// a manually rendered `<head>`, and this script was silently dropped from the served HTML there —
// the theme then survived the toggle but not a reload.
const REMEMBER = `try{if(localStorage.getItem('${THEME_KEY}')==='dark')document.documentElement.dataset.theme='dark'}catch(e){}`;

export const metadata: Metadata = {
  title: 'Therblig Studio',
  description: 'Browse BPMN processes and compare file versions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The script below stamps `data-theme` before React hydrates, so the server's `<html>` and the
    // browser's disagree by exactly that attribute. That is the intended behaviour, not a bug to be
    // patched up, and this is the attribute React provides for saying so.
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: REMEMBER }} />
        {children}
      </body>
    </html>
  );
}
