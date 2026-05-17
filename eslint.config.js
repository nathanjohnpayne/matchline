// eslint.config.js
//
// Auto-generated from nathanjohnpayne/mergepath's templated source
// at examples/eslint.config.js (per the Mergepath ESLint standard,
// mergepath#250). Edit upstream, not this rendered copy — local
// edits will be overwritten on the next propagation run.
//

import js from "@eslint/js";
import globals from "globals";

import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  // Ignore generated / vendored output. Customize per-consumer via
  // a follow-up commit on the propagation PR if a repo needs extras
  // (e.g., functions/lib for cloud-functions repos).
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      ".astro/**",
      ".next/**",
      ".vercel/**",
      // CONSUMER-LOCAL: agent-spawned git worktrees for parallel PR
      // exploration. Local state — linting them double-counts
      // findings against the main tree.
      ".claude/worktrees/**",
      // CONSUMER-LOCAL: Cloud Functions compiled output (tsc -b emits
      // here). functions/src/ is the canonical source; linting the
      // compiled `.js` duplicates findings already covered upstream.
      "functions/lib/**",
      // CONSUMER-LOCAL: ad-hoc debugging / experiment scripts. The
      // tmp/ directory holds throwaway `*.mts` files for one-off
      // investigations (vocab-collect, threshold-experiment,
      // match-trace, etc.). Not production code; linting them is
      // counterproductive (intentional `any`/`_` patterns abound).
      "tmp/**",
    ],
  },

  // Baseline JS recommended — required by the Mergepath policy floor.
  js.configs.recommended,

  // Apply browser + node globals to all JS sources by default. Narrow
  // these per-file-pattern in a follow-up commit if the repo has a
  // clean split (e.g., scripts/* node-only, src/* browser-only).
  //
  // `*.cjs` files are split out so ESLint parses them as CommonJS
  // (`sourceType: "commonjs"`) rather than ES modules — otherwise
  // top-level `require`/`module.exports` and CommonJS scope rules
  // produce false-positive parse errors. The defaults ESLint applies
  // by extension are: `module` for `.js`/`.mjs`, `commonjs` for
  // `.cjs`; we make that explicit here so the policy is
  // self-documenting.
  {
    files: ["**/*.{js,mjs,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
  },

  // TypeScript recommended ruleset — applied to .ts / .tsx via the
  // typescript-eslint plugin's flat-config preset. Includes the
  // parser, the recommended rule set, and the file-glob targeting.
  ...tseslint.configs.recommended,


  // React + React Hooks recommended rulesets — applied to .jsx / .tsx.
  // Detect the React version automatically from package.json. The
  // React 17+ JSX transform makes `react/react-in-jsx-scope` obsolete;
  // turn it off explicitly so the rule doesn't flag every component.
  {
    files: ["**/*.{jsx,tsx}"],
    plugins: {
      react,
      "react-hooks": reactHooks,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
    },
    settings: {
      react: { version: "detect" },
    },
  },

  // ─────────────────────────────────────────────────────────────────
  // CONSUMER-LOCAL POLICY — split by file type. MUST be LAST.
  //
  // Same template policy class as dpr#83 / ffb#274 / tadlock#58 /
  // nathanpaynedotcom#373, but split into three target-scoped
  // blocks per typescript-eslint v8 guidance (CodeRabbit Major on
  // matchline#234): the base `no-unused-vars` enabled by
  // `js.configs.recommended` and the typescript-eslint variant
  // conflict if both run on the same file — the rule is intended
  // as a direct replacement scoped to TS files only.
  //
  // Block 1 — JS/JSX files: apply `^_`-prefix to the base
  //   `no-unused-vars` (the TS variant is not enabled here).
  // Block 2 — JSX/TSX (React files): React + React Compiler off.
  // Block 3 — TS/TSX/MTS/CTS: TS-specific rules incl. the
  //   replacement `no-unused-vars`. Disabling the base rule on
  //   the same files prevents the double-report.
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    rules: {
      "no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
    },
  },
  {
    files: ["**/*.{jsx,tsx}"],
    rules: {
      "react/prop-types": "off",
      "react/no-unescaped-entities": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
    },
  },
];
