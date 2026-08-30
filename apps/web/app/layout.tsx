import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Geist, Newsreader } from 'next/font/google';
import { LanguageProvider } from '@/src/i18n/language-provider';
import { LOCALE_COOKIE, resolveLocale } from '@/src/i18n/messages';
import './globals.css';

const geist = Geist({ variable: '--font-geist-sans', subsets: ['latin-ext'] });
const newsreader = Newsreader({ variable: '--font-newsreader', subsets: ['latin-ext'] });

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : 'http://localhost:3000',
  ),
  title: 'Nét — Draw What Words Cannot Say',
  description: 'Draw, annotate, and send images as naturally as a message.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Nét',
  icons: { icon: '/icon-192.png', apple: '/icon-192.png' },
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Nét' },
  openGraph: {
    title: 'Nét — Draw What Words Cannot Say',
    description: 'Draw, annotate, and send it like a message.',
    images: [{ url: '/og.png', width: 1536, height: 1024, alt: 'Nét — Draw What Words Cannot Say' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Nét — Draw What Words Cannot Say',
    description: 'Draw, annotate, and send it like a message.',
    images: ['/og.png'],
  },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return (
    <html lang={locale}>
      <head><meta name="theme-color" content="#6f4ee8" /></head>
      <body className={`${geist.variable} ${newsreader.variable}`}><LanguageProvider initialLocale={locale}>{children}</LanguageProvider></body>
    </html>
  );
}
