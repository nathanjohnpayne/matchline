/**
 * Hidden debug route for the PDF prototype (#50).
 *
 * Mounted at `/debug/pdf-prototype`. NOT linked from the
 * main nav per the spec — this is a fidelity-evaluation
 * surface, not a user-facing feature. Reachable by typing
 * the URL directly.
 *
 * Renders the PDF inline via `<PDFViewer>` so the
 * developer can iterate on layout changes with browser
 * reload. Also exposes a `<PDFDownloadLink>` button so
 * the rendered file can be opened in macOS Preview /
 * Adobe Reader for the binary "would I send this" call
 * outside the browser's PDF viewer.
 *
 * The fixture (Nathan + Compute SPM shape) lives in
 * `lib/resumePdf/sampleContent.ts` and matches the
 * structure of #135's eval fixture pair.
 */

import {
  PDFDownloadLink,
  PDFViewer,
} from "@react-pdf/renderer";
import { useState, type ReactElement } from "react";

import { ResumePdf } from "../../lib/resumePdf/ResumePdf.tsx";
import {
  SAMPLE_CONTENT,
  SAMPLE_HEADER,
} from "../../lib/resumePdf/sampleContent.ts";

export default function PdfPrototype(): ReactElement {
  const [showInline, setShowInline] = useState(true);

  return (
    <section className="mx-auto max-w-6xl p-6 space-y-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          PDF prototype
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-3xl">
          Phase 1 fidelity evaluation per{" "}
          <a
            href="https://github.com/nathanjohnpayne/matchline/issues/50"
            className="underline"
          >
            #50
          </a>
          . Renders Nathan's resume content (sample shape) through{" "}
          <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 rounded">
            @react-pdf/renderer
          </code>{" "}
          to evaluate layout fidelity for Phase 2's full export pipeline (
          <a
            href="https://github.com/nathanjohnpayne/matchline/issues/33"
            className="underline"
          >
            #33
          </a>
          ).
        </p>
        <p className="text-xs text-zinc-500 max-w-3xl">
          Evaluation criteria: tight leading on dense bullets, mixed font
          weights at small sizes, single-page widow/orphan control, page-break
          behavior. Sample content shape mirrors what Phase 1 generation (#22)
          produces — flat <code>bullets[]</code>, no employer/tenure
          grouping (deferred to Phase 2 schema migration). Any "would I send
          this" feedback should target the structural layout, not the absence
          of company/date grouping.
        </p>
      </header>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setShowInline((s) => !s)}
          className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
          data-testid="pdf-prototype-toggle-inline"
        >
          {showInline ? "Hide inline preview" : "Show inline preview"}
        </button>
        <PDFDownloadLink
          document={
            <ResumePdf header={SAMPLE_HEADER} content={SAMPLE_CONTENT} />
          }
          fileName="nathan-payne-pdf-prototype.pdf"
          className="rounded bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-3 py-1 text-sm font-medium hover:opacity-90"
          data-testid="pdf-prototype-download"
        >
          {({ loading }) => (loading ? "Preparing PDF…" : "Download PDF")}
        </PDFDownloadLink>
      </div>

      {showInline && (
        <div
          className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden"
          style={{ height: "1100px" }}
          data-testid="pdf-prototype-viewer"
        >
          <PDFViewer width="100%" height="100%" showToolbar={true}>
            <ResumePdf header={SAMPLE_HEADER} content={SAMPLE_CONTENT} />
          </PDFViewer>
        </div>
      )}
    </section>
  );
}
