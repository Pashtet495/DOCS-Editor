import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DOCS Editor — WYSIWYG с RAG и AI-агентом",
  description:
    "Редактор документов на базе superdoc с промежуточным JSON-слоем, эмбеддингами блоков для RAG, встроенным AI-агентом и упаковкой в формат DOCS.",
};

// Vue feature flags MUST be defined before superdoc (which uses Vue's
// esm-bundler build) is imported. Inline script in <head> runs before any
// module script.
const vueFlags = `(window).__VUE_OPTIONS_API__=true;(window).__VUE_PROD_DEVTOOLS__=false;(window).__VUE_PROD_HYDRATION_MISMATCH_DETAILS__=false;`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: vueFlags }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground h-screen overflow-hidden`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
