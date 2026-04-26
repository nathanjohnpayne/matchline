/**
 * Resume PDF prototype (#50).
 *
 * Renders a `GeneratedAssetContent` (the shape Phase 1
 * generation #22 produces) as a single-page PDF using
 * `@react-pdf/renderer`. The component is a spike, not a
 * production export surface — its purpose is to surface
 * `react-pdf`'s layout-fidelity ceiling on a tight-density
 * resume layout BEFORE Phase 2's full export pipeline (#33)
 * commits to a library choice.
 *
 * What this prototype is testing (per #50 spec):
 *
 *   - Tight leading on dense bullets (a real resume runs
 *     ~6-line bullets with 1.2-1.3 line-height; can react-
 *     pdf hit that without overflow / orphan issues?).
 *   - Mixed font weights at small sizes (10pt body,
 *     11pt headings, 8pt contact line — react-pdf's
 *     default Helvetica family has known weight quirks
 *     under ~10pt).
 *   - Section widow / orphan control on a single-page
 *     layout (V1 generation flat-bullet schema means no
 *     employer grouping, but bullet wrapping still needs
 *     to behave on long entries).
 *   - Page-break behavior if content exceeds one page —
 *     V1 should fit, but the prototype evaluates whether
 *     the model gracefully spills.
 *
 * What this prototype is NOT:
 *
 *   - A production export. The Application Editor (#24)
 *     calls a separate export pipeline in #33.
 *   - A polish pass. Visual fidelity is Nathan's binary
 *     "would I send this" call; this is structural shape
 *     and density.
 *   - Multi-format. DOCX + plain-text live in #33.
 */

import {
  Document,
  Font,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";
// React import is required for the CLI script
// (`scripts/pdf-prototype.ts`) which runs through `tsx`
// without the project-reference tsconfig.app.json's
// `"jsx": "react-jsx"` automatic runtime — tsx picks up
// the empty root tsconfig.json which defaults to classic
// JSX, which requires React in scope. Vite's frontend
// build still uses the automatic runtime; this import
// is tree-shaken by Vite's production bundle.
import * as React from "react";
import type { ReactElement } from "react";

import type { GeneratedAssetContent } from "../../types/crm.ts";

import type { ResumeHeader } from "./sampleContent.ts";

// Suppress "React is declared but never read" — the
// import is needed for tsx's classic JSX runtime, see
// the import comment above.
void React;

// react-pdf ships with PostScript-named built-ins
// (Helvetica, Times-Roman, Courier). Helvetica is the
// default; we name it explicitly so a future Font.register
// swap is one line.
Font.registerHyphenationCallback((word) => [word]);

const styles = StyleSheet.create({
  // Page geometry: US Letter, 0.5" margins all around.
  // Tight enough to fit a dense one-pager; standard
  // enough that ATS systems handle it.
  page: {
    fontFamily: "Helvetica",
    fontSize: 10,
    lineHeight: 1.4,
    paddingTop: 36,
    paddingBottom: 36,
    paddingHorizontal: 48,
    color: "#111111",
  },
  // Header block: name (large, bold) + title line + contact line.
  headerName: {
    fontSize: 18,
    fontFamily: "Helvetica-Bold",
    marginBottom: 2,
  },
  headerTitle: {
    fontSize: 11,
    color: "#374151",
    marginBottom: 4,
  },
  headerContactLine: {
    fontSize: 8.5,
    color: "#4b5563",
  },
  headerContactSeparator: {
    color: "#9ca3af",
  },
  // Section heading: small caps look via uppercase + letter-
  // spacing. react-pdf doesn't support font-variant: small-caps
  // natively so we approximate.
  sectionHeading: {
    fontSize: 9.5,
    fontFamily: "Helvetica-Bold",
    color: "#111111",
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginTop: 14,
    marginBottom: 4,
    borderBottomWidth: 0.75,
    borderBottomColor: "#9ca3af",
    paddingBottom: 2,
  },
  summaryText: {
    fontSize: 10,
    lineHeight: 1.45,
    color: "#1f2937",
  },
  bulletRow: {
    flexDirection: "row",
    marginBottom: 4,
  },
  bulletMarker: {
    width: 10,
    fontSize: 10,
    color: "#4b5563",
  },
  bulletText: {
    flex: 1,
    fontSize: 10,
    lineHeight: 1.4,
    color: "#1f2937",
  },
  skillRow: {
    flexDirection: "row",
    marginBottom: 2,
  },
  skillBullet: {
    width: 10,
    fontSize: 10,
    color: "#4b5563",
  },
  skillText: {
    flex: 1,
    fontSize: 10,
    lineHeight: 1.35,
    color: "#1f2937",
  },
  educationLine: {
    fontSize: 10,
    lineHeight: 1.35,
    color: "#1f2937",
    marginBottom: 2,
  },
});

export interface ResumePdfProps {
  readonly header: ResumeHeader;
  readonly content: GeneratedAssetContent;
}

/**
 * The full PDF Document. Pass to `<PDFViewer>` for inline
 * preview, `<PDFDownloadLink>` for download, or
 * `pdf().toFile(...)` for CLI rendering.
 */
export function ResumePdf({ header, content }: ResumePdfProps): ReactElement {
  return (
    <Document
      title={`${header.name} — Resume`}
      author={header.name}
      // Subject doubles as a shape signature so a future
      // exporter version can be detected from the PDF
      // metadata without re-rendering.
      subject="Matchline Phase 1 PDF prototype (#50)"
    >
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <View>
          <Text style={styles.headerName}>{header.name}</Text>
          <Text style={styles.headerTitle}>{header.title}</Text>
          <Text style={styles.headerContactLine}>
            {[
              header.location,
              ...header.contact.map((c) => c.value),
            ].join("  ·  ")}
          </Text>
        </View>

        {/* Summary */}
        <Text style={styles.sectionHeading}>Summary</Text>
        <Text style={styles.summaryText}>{content.summary.text}</Text>

        {/* Experience bullets (V1: flat, no employer grouping per #122) */}
        <Text style={styles.sectionHeading}>Experience</Text>
        {content.bullets.map((b) => (
          <View key={b.id} style={styles.bulletRow} wrap={false}>
            <Text style={styles.bulletMarker}>•</Text>
            <Text style={styles.bulletText}>{b.text}</Text>
          </View>
        ))}

        {/* Skills */}
        <Text style={styles.sectionHeading}>Skills</Text>
        {content.skills.map((s) => (
          <View key={s.id} style={styles.skillRow}>
            <Text style={styles.skillBullet}>•</Text>
            <Text style={styles.skillText}>{s.text}</Text>
          </View>
        ))}

        {/* Education (optional per the type). Wrap in View
            rather than React.Fragment — react-pdf's
            renderer doesn't always handle Fragments at the
            Document/Page-tree level cleanly. */}
        {content.education !== undefined &&
        content.education.length > 0 ? (
          <View>
            <Text style={styles.sectionHeading}>Education</Text>
            {content.education.map((e) => (
              <Text key={e.id} style={styles.educationLine}>
                {e.text}
              </Text>
            ))}
          </View>
        ) : null}
      </Page>
    </Document>
  );
}
