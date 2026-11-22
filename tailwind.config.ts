import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "hsl(var(--paper))",
        "paper-soft": "hsl(var(--paper-soft))",
        ink: "hsl(var(--ink))",
        "ink-soft": "hsl(var(--ink-soft))",
        cinnabar: "hsl(var(--cinnabar))",
        border: "hsl(var(--border))",
        muted: "hsl(var(--muted))",
      },
      fontFamily: {
        serif: ['"Noto Serif SC"', '"Source Han Serif SC"', '"Songti SC"', "STSong", "SimSun", "serif"],
        sans: ['"PingFang SC"', '"Noto Sans SC"', '"Microsoft YaHei"', "Arial", "sans-serif"],
      },
      boxShadow: {
        paper: "0 10px 30px rgba(60, 40, 20, 0.12)",
      },
    },
  },
  plugins: [],
};
export default config;
