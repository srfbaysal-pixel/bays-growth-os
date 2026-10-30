import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SwRegister } from '@/components/SwRegister';

export const metadata: Metadata = {
  title: { default: 'BaysSystems Acquisition', template: '%s · BaysSystems' },
  description: 'BaysSystems müşteri kazanım paneli',
  manifest: '/manifest.webmanifest',
  applicationName: 'BaysSystems Acq',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'BaysSystems' },
  icons: { icon: '/icons/icon-192.png', apple: '/icons/icon-192.png' }
};
export const viewport: Viewport = { themeColor: '#1d4ed8', width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
