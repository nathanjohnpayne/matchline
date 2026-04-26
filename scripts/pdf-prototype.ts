#!/usr/bin/env -S tsx
/**
 * CLI render of the PDF prototype (#50).
 *
 * Renders the sample-content `ResumePdf` to a real `.pdf`
 * file on disk. Convenient for the binary "would I send
 * this?" review per #50 spec — the in-browser
 * `<PDFViewer>` at `/debug/pdf-prototype` uses Chromium's
 * built-in renderer which masks rendering quirks Adobe
 * Reader / macOS Preview / production PDF tooling would
 * surface.
 *
 * Usage:
 *
 *   npx tsx scripts/pdf-prototype.tsx
 *   open /tmp/matchline-pdf-prototype.pdf
 *
 * Exit codes:
 *   0 — render succeeded
 *   1 — render threw
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// `tsx` (esbuild under the hood) uses the classic JSX
// runtime by default for .tsx files outside a project
// with explicit jsx-runtime config. We use
// `React.createElement` directly here to avoid any
// runtime-mode mismatch — the JSX in the actual component
// (`src/lib/resumePdf/ResumePdf.tsx`) goes through Vite's
// react-jsx automatic runtime when the module loads.
// React-Element trees compose across runtime modes, so
// the createElement call here drives a tree built by
// react-jsx without issue.
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";

import { ResumePdf } from "../src/lib/resumePdf/ResumePdf.tsx";
import {
  SAMPLE_CONTENT,
  SAMPLE_HEADER,
} from "../src/lib/resumePdf/sampleContent.ts";

const DEFAULT_OUT = join(tmpdir(), "matchline-pdf-prototype.pdf");

async function main(): Promise<number> {
  const outPath = process.argv[2] ?? DEFAULT_OUT;
  try {
    const buf = await renderToBuffer(
      createElement(ResumePdf, {
        header: SAMPLE_HEADER,
        content: SAMPLE_CONTENT,
      }),
    );
    writeFileSync(outPath, buf);
    console.log(`PDF prototype rendered to: ${outPath}`);
    console.log(`Open with: open "${outPath}"`);
    return 0;
  } catch (err) {
    console.error("PDF prototype render failed:", err);
    return 1;
  }
}

void main().then((code) => {
  if (code !== 0) process.exit(code);
});
