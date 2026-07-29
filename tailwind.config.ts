import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#12141A",
        paper: "#F5F4F0",
        signal: "#E8483A",
      },
    },
  },
  plugins: [],
};
export default config;
