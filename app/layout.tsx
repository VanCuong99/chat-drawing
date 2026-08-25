import type { Metadata } from 'next';
import { Geist, Newsreader } from 'next/font/google';
import './globals.css';

const geist = Geist({ variable: '--font-geist-sans', subsets: ['latin-ext'] });
const newsreader = Newsreader({ variable: '--font-newsreader', subsets: ['latin-ext'] });

export const metadata: Metadata = {
  metadataBase: new URL('https://net-ve-dieu-kho-noi.vancuong-0399.chatgpt.site'),
  title: 'Nét — Vẽ điều khó nói',
  description: 'Vẽ, ghi chú và gửi hình ảnh như một tin nhắn bình thường.',
  openGraph: {
    title: 'Nét — Vẽ điều khó nói',
    description: 'Vẽ, ghi chú và gửi như một tin nhắn.',
    images: [{ url: '/og.png', width: 1536, height: 1024, alt: 'Nét — Vẽ điều khó nói' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Nét — Vẽ điều khó nói',
    description: 'Vẽ, ghi chú và gửi như một tin nhắn.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body className={`${geist.variable} ${newsreader.variable}`}>{children}</body>
    </html>
  );
}
