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
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html>
      <Head>
        <link rel="icon" href="/logo.png" />
        <meta property="og:title" content="Rendimientos App" />
        <meta property="og:description" content="Ahorra BTC de manera soberana" />
        <meta property="og:image" content="/logo.png" />
        <meta property="og:url" content="https://rendimientos-5dbb9.web.app/" />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Rendimientos App" />
        <meta name="twitter:description" content="Ahorra BTC de manera soberana" />
        <meta name="twitter:image" content="/logo.png" />
      </Head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}