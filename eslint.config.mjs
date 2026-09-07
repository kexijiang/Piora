import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";
import reactHooks from "eslint-plugin-react-hooks";

const eslintConfig = [
  {
    ignores: [
      ".verification/**",
      "desktop/dist/**",
      "desktop/release/**",
      "Piora-*-win-x64/**",
      "website/.next/**",
      "website/.vinext/**",
      "website/.wrangler/**",
      "website/dist/**",
      "website/node_modules/**",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/immutability": "error",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: ["lib/team-*.ts"],
    rules: {
      complexity: ["error", 25],
      "max-lines-per-function": ["error", { max: 180, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ["components/Room*.tsx"],
    rules: {
      complexity: ["error", 25],
    },
  },
];

export default eslintConfig;
