import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Control Room — Your projects, in focus",
  description: "Your private planning home for TAMENNI and Trade Graph. Clear milestones, next actions and decisions, wherever you are.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
