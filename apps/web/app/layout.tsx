import "./styles.css";
import { ReactNode } from "react";

export const metadata = {
  title: "Typst School",
  description: "Typst realtime collaboration platform"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

