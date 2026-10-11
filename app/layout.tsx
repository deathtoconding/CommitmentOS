import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CommitmentOS',
  description: 'Make sure your company does what it said it would do.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
