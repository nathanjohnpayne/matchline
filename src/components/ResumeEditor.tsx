/**
 * ResumeEditor — TipTap rich-text editor for the Onboarding
 * resume paste (#264).
 *
 * Pasting Markdown renders as formatted rich text (headings, bold,
 * bullet / numbered lists, code) instead of literal `#` / `*` / `-`
 * characters. On every change the editor emits its content serialized
 * back to Markdown, so the Onboarding route keeps a plain text/markdown
 * `value` to feed the (text-only) extraction pipeline.
 *
 * Scaffolding mirrors Friends & Family Billing's `TemplateEditor`
 * (`useEditor` + `StarterKit` + `Placeholder` + `EditorContent`). The
 * Markdown parse-on-paste + `getMarkdown()` serialization come from the
 * `tiptap-markdown` extension — replacing F&F's `%token%` paste
 * conversion, which is billing-specific and intentionally NOT copied.
 */

import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { useEffect, type ReactElement } from "react";

interface ResumeEditorProps {
  /** Called with the editor content serialized to Markdown on every change. */
  readonly onChange: (markdown: string) => void;
  /** Disable editing (e.g. while an extraction call is in flight). */
  readonly disabled?: boolean;
  readonly placeholder?: string;
}

/** `tiptap-markdown` attaches a serializer under `editor.storage.markdown`. */
interface MarkdownStorage {
  readonly getMarkdown: () => string;
}

export default function ResumeEditor({
  onChange,
  disabled = false,
  placeholder,
}: ResumeEditorProps): ReactElement {
  const editor = useEditor({
    // immediatelyRender:false keeps server/static rendering
    // (`renderToStaticMarkup` in the route tests, plus React 19 strict
    // mode) from trying to mount ProseMirror without a DOM — the editor
    // mounts in an effect after the first render instead.
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      // Parse pasted text as Markdown so `# H` / `**b**` / `- x` render,
      // and expose getMarkdown() to serialize back to text for extraction.
      // `breaks: true` keeps single newlines as hard breaks instead of
      // collapsing them to spaces — a plain-text resume (company / title /
      // dates on separate lines) is the DEFAULT onboarding input and must
      // keep its line structure for extraction, matching the old textarea.
      // (Codex P2 on #267.)
      Markdown.configure({
        transformPastedText: true,
        transformCopiedText: true,
        breaks: true,
      }),
    ],
    editable: !disabled,
    editorProps: {
      attributes: {
        class:
          "resume-prose min-h-[20rem] w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 transition-colors duration-150 focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-100",
        "aria-label": "Resume text",
        "data-testid": "onboarding-editor",
      },
    },
    onUpdate({ editor: ed }) {
      const storage = (ed.storage as { markdown?: MarkdownStorage }).markdown;
      onChange(storage ? storage.getMarkdown() : ed.getText());
    },
  });

  // Keep the editor's editable state in sync with `disabled` (the
  // initial value is set at creation; this handles toggles after mount).
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  return (
    <div
      data-testid="onboarding-editor-wrapper"
      className={disabled ? "opacity-60" : undefined}
      aria-disabled={disabled || undefined}
    >
      <EditorContent editor={editor} />
    </div>
  );
}
