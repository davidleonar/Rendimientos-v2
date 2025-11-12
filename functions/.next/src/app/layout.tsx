import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Head from "next/head";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Rendimientos App",
  description: "Ahorra BTC de manera soberana",
  icons: {
    icon: '/favicon.ico', // Add this for browser tab
    apple: [
      { url: '/AppIcon.appiconset/180.png', sizes: '180x180' },
      // Add others as needed
    ],
  },
  openGraph: {
    title: 'Rendimientos App',
    description: 'Ahorra BTC de manera soberana',
    url: 'https://rendimientos.net/',
    siteName: 'Rendimientos App',
    images: [{ url: 'https://rendimientos.net/AppIcon.appiconset/1024.png' }]
  },

};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html>
      <Head>
        <link rel="apple-touch-icon" sizes="180x180" href="/AppIcon.appiconset/180.png" />
        <link rel="apple-touch-icon" sizes="152x152" href="/AppIcon.appiconset/152.png" />
        <link rel="apple-touch-icon" sizes="120x120" href="/AppIcon.appiconset/120.png" />
        <link rel="apple-touch-icon" sizes="57x57" href="/AppIcon.appiconset/57.png" />
        <link rel="icon" type="image/png" sizes="1024x1024" href="/AppIcon.appiconset/1024.png" />
        <link rel="icon" type="image/png" sizes="180x180" href="/AppIcon.appiconset/180.png" />
        <link rel="icon" type="image/png" sizes="152x152" href="/AppIcon.appiconset/152.png" />
        <link rel="icon" type="image/png" sizes="120x120" href="/AppIcon.appiconset/120.png" />
        <link rel="icon" type="image/png" sizes="57x57" href="/AppIcon.appiconset/57.png" />
        <meta property="og:title" content="Rendimientos App" />
        <meta property="og:description" content="Ahorra BTC de manera soberana" />
        <meta property="og:image" content="https://rendimientos.net/AppIcon.appiconset/1024.png" />
        <meta property="og:url" content="https://rendimientos.net/" />
        <meta property="og:type" content="website" />
        <meta property="og:image:width" content="1024" />
        <meta property="og:image:height" content="1024" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Rendimientos App" />
        <meta name="twitter:description" content="Ahorra BTC de manera soberana" />
        <meta name="twitter:image" content="https://rendimientos.net/AppIcon.appiconset/1024.png" />
      </Head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}