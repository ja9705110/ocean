import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Interactive World Draw",
    template: "%s｜Interactive World Draw",
  },
  description: "由參與者共同畫出的即時互動世界。",
};

export const viewport: Viewport = {
  themeColor: "#04060c",
  // 參與者端有全螢幕繪圖區，禁止縮放以免畫圖時誤觸雙指縮放
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-Hant">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
