import type { Metadata } from 'next';
import './globals.css';
import { I18nProvider } from '@/lib/i18n';
import { AppShell } from '@/components/AppShell';

export const metadata: Metadata = {
  title: 'Simorgh Grid — Electrical Projects & Protection Command Center',
  description: 'Simorgh Grid — Electro Kavir. Electrical projects, protection relay monitoring and SCADA integration.',
  icons: {
    icon: '/favicon.png',
    apple: '/apple-touch-icon.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex bg-graphite-950 text-graphite-100">
        <I18nProvider>
          <AppShell>{children}</AppShell>
        </I18nProvider>
      </body>
    </html>
  );
}
