/**
 * The `source_ref` format for Experience Units extracted from an
 * uploaded artifact (#518, parent #87):
 *
 *     artifact://users/{uid}/artifacts/{filename}#{section}
 *
 * The path is the file's Firebase Storage object path; the fragment
 * names the section or page the Unit came from and is optional.
 *
 * Each of `uid`, `filename` and `section` is percent-encoded with
 * `encodeURIComponent`, so a filename may contain `#`, `/`, spaces or
 * non-ASCII characters without colliding with the fragment separator
 * or the path segments. The Storage path itself is the decoded form;
 * the encoding exists only inside `source_ref`.
 *
 * Parsing is strict: a ref parses only if it is exactly what
 * `buildArtifactSourceRef` would produce for the parsed parts, so
 * `buildArtifactSourceRef(parseArtifactSourceRef(ref)!) === ref` for
 * every ref that parses. Anything else, including every resume,
 * LinkedIn, long-form or manual ref, parses to `null` rather than
 * throwing, so callers can probe an arbitrary `source_ref` safely.
 *
 * A leaf module with no imports, so the app can import it across the
 * package boundary without pulling functions-only dependencies into
 * the client (see the header of `./evidence.ts`).
 */

export const ARTIFACT_SOURCE_REF_SCHEME = "artifact://";

export interface ArtifactSourceRef {
  /** Firebase Auth UID of the artifact's owner. */
  readonly uid: string;
  /** The uploaded file's name, as stored under `users/{uid}/artifacts/`. */
  readonly filename: string;
  /** The section or page within the artifact; absent for the whole file. */
  readonly section?: string;
}

/**
 * Build the `source_ref` for a Unit extracted from an artifact.
 *
 * Throws a `RangeError` when `uid` or `filename` is empty, or when
 * `section` is present but empty: none of those has a ref that parses
 * back to the same input. Omit `section` for a whole-file ref.
 */
export function buildArtifactSourceRef(ref: ArtifactSourceRef): string {
  if (ref.uid.length === 0) {
    throw new RangeError("artifact source_ref: uid must not be empty");
  }
  if (ref.filename.length === 0) {
    throw new RangeError("artifact source_ref: filename must not be empty");
  }
  if (ref.section !== undefined && ref.section.length === 0) {
    throw new RangeError(
      "artifact source_ref: section must be omitted rather than empty",
    );
  }
  const path = `users/${encodeURIComponent(ref.uid)}/artifacts/${encodeURIComponent(ref.filename)}`;
  const fragment =
    ref.section === undefined ? "" : `#${encodeURIComponent(ref.section)}`;
  return `${ARTIFACT_SOURCE_REF_SCHEME}${path}${fragment}`;
}

/**
 * Parse an artifact `source_ref`. Returns `null` for any value that
 * is not one `buildArtifactSourceRef` produces.
 */
export function parseArtifactSourceRef(
  sourceRef: string,
): ArtifactSourceRef | null {
  if (!sourceRef.startsWith(ARTIFACT_SOURCE_REF_SCHEME)) return null;
  const rest = sourceRef.slice(ARTIFACT_SOURCE_REF_SCHEME.length);

  // Encoded parts contain no raw `#`, so the first one is the separator.
  const hashAt = rest.indexOf("#");
  const pathPart = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const fragmentPart = hashAt === -1 ? undefined : rest.slice(hashAt + 1);

  const segments = pathPart.split("/");
  if (
    segments.length !== 4 ||
    segments[0] !== "users" ||
    segments[2] !== "artifacts"
  ) {
    return null;
  }

  const uid = decodeStrict(segments[1]);
  const filename = decodeStrict(segments[3]);
  const section =
    fragmentPart === undefined ? undefined : decodeStrict(fragmentPart);
  if (uid === null || filename === null || section === null) return null;
  if (uid.length === 0 || filename.length === 0) return null;
  if (section !== undefined && section.length === 0) return null;

  return section === undefined ? { uid, filename } : { uid, filename, section };
}

/**
 * Decode one percent-encoded part, or return `null` if it is malformed
 * or not in the canonical encoding `encodeURIComponent` produces. The
 * canonical check keeps the build/parse pair a bijection: without it,
 * `a b.pdf` and `a%20b.pdf` would both parse to the same filename.
 */
function decodeStrict(encoded: string): string | null {
  // Both calls sit inside the guard: `decodeURIComponent` throws on a
  // malformed escape, and `encodeURIComponent` throws on a raw lone
  // surrogate, which decoding passes through unchanged.
  try {
    const decoded = decodeURIComponent(encoded);
    return encodeURIComponent(decoded) === encoded ? decoded : null;
  } catch {
    return null;
  }
}
