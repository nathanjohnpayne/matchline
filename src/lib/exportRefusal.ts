/**
 * An export the app itself refused, with a sentence written for the user
 * (#523). The app's own guards throw it: the editor has no Application or
 * asset id to export (`exportCurrentAsset`), or the callable returned a
 * download link that is not safe to load (`startDownload`).
 *
 * The Export menu shows an `ExportRefusal`'s message verbatim. Any other
 * error that is not a callable error stays unmarked and shows the generic
 * "Something went wrong" copy, because its message was never written for
 * a user. Lives in `src/lib/` so the menu (`src/components/`) and the
 * export service and editor action can all import it without the menu
 * importing either of them.
 */
export class ExportRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportRefusal";
  }
}
