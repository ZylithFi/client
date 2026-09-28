import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        zVoid: "#07090e",
        zDeep: "#0f1825",
        zShadow: "#172643",
        zCore: "#182F57",
        zMid: "#253d6b",
        zHighlight: "#365380",
        zBright: "#4d6f9e",
        zFrost: "#8aafd4",
        zWhite: "#c8dff5",
      },
      fontFamily: {
        sans: ["Archivo Variable", "Archivo", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
