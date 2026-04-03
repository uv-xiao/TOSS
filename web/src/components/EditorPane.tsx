import CodeMirror from "@uiw/react-codemirror";
import {
  StateEffect,
  type StateEffectType,
  StateField,
  Transaction
} from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { latex } from "codemirror-lang-latex";
import {
  HighlightStyle,
  Language,
  LanguageSupport,
  defineLanguageFacet,
  language as languageFacet,
  syntaxHighlighting
} from "@codemirror/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
  WidgetType
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { useEffect, useMemo, useRef } from "react";
import { tags } from "@lezer/highlight";
import { TypstParser, typstHighlight as typstNodeHighlight } from "codemirror-lang-typst";

export type EditorChange = {
  from: number;
  to: number;
  insert: string;
};

type EditorDeltaHandlerResult = boolean | void;

type RemoteCursor = {
  id: string;
  name: string;
  color: string;
  line?: number;
  column?: number;
};

class RemoteCursorWidget extends WidgetType {
  constructor(
    private readonly color: string,
    private readonly label: string
  ) {
    super();
  }

  eq(other: RemoteCursorWidget): boolean {
    return other.color === this.color && other.label === this.label;
  }

  toDOM(): HTMLElement {
    const root = document.createElement("span");
    root.className = "remote-cursor";
    root.style.setProperty("--cursor-color", this.color);
    const tip = document.createElement("span");
    tip.className = "remote-cursor-label";
    tip.textContent = this.label;
    root.appendChild(tip);
    return root;
  }
}

function buildRemoteCursorDecorations(
  view: EditorView,
  cursors: RemoteCursor[]
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const cursor of cursors) {
    if (!cursor.line || !cursor.column) continue;
    const lineNumber = Math.max(1, Math.min(cursor.line, view.state.doc.lines));
    const line = view.state.doc.line(lineNumber);
    const column = Math.max(1, Math.min(cursor.column, line.length + 1));
    const position = line.from + column - 1;
    builder.add(
      position,
      position,
      Decoration.widget({
        widget: new RemoteCursorWidget(cursor.color, cursor.name),
        side: 1
      })
    );
  }
  return builder.finish();
}

const setRemoteCursorsEffect = StateEffect.define<RemoteCursor[]>();

const remoteCursorPlugin = ViewPlugin.fromClass(
  class {
    cursors: RemoteCursor[] = [];
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildRemoteCursorDecorations(view, []);
    }

    update(update: ViewUpdate) {
      let changed = update.docChanged;
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(setRemoteCursorsEffect)) {
            this.cursors = effect.value;
            changed = true;
          }
        }
      }
      if (changed) {
        this.decorations = buildRemoteCursorDecorations(update.view, this.cursors);
      }
    }
  },
  {
    decorations: (instance) => instance.decorations
  }
);

const typstEditorHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "#0b3a63", fontWeight: "700" },
  { tag: tags.comment, color: "#667085", fontStyle: "italic" },
  { tag: [tags.string, tags.special(tags.string)], color: "#0a7a52" },
  { tag: [tags.number, tags.integer, tags.float, tags.bool], color: "#9a3d02" },
  {
    tag: [
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.keyword
    ],
    color: "#5b3cc4",
    fontWeight: "650"
  },
  { tag: [tags.variableName, tags.name], color: "#243447" },
  { tag: [tags.labelName, tags.link], color: "#0e65aa" },
  { tag: [tags.monospace, tags.contentSeparator, tags.controlOperator], color: "#1f4f7a" },
  { tag: tags.invalid, color: "#b42318", textDecoration: "wavy underline" }
]);

const typstLanguageData = defineLanguageFacet({
  commentTokens: { line: "//", block: { open: "/*", close: "*/" } }
});

function buildTypstLanguageSupport() {
  const parser = new (TypstParser as unknown as new (highlighting: unknown) => TypstParser)(typstNodeHighlight);
  const resetParserEffect = StateEffect.define<null>();
  const safeParserSync = StateField.define<null>({
    create() {
      return null;
    },
    update(value, transaction) {
      if (transaction.startState.facet(languageFacet) !== transaction.state.facet(languageFacet)) {
        parser.clearParser();
        return null;
      }
      if (transaction.docChanged) {
        // Avoid wasm incremental-edit panics by reparsing from the latest source.
        parser.clearParser();
      }
      for (const effect of transaction.effects) {
        if (effect.is(resetParserEffect)) {
          // Controlled value swaps (revision switching/realtime hydration) can bypass
          // incremental parser bookkeeping. Explicit reset keeps highlights aligned.
          parser.clearParser();
          break;
        }
      }
      return value;
    }
  });
  const language = new Language(typstLanguageData, parser, [safeParserSync], "typst");
  return {
    support: new LanguageSupport(language, [syntaxHighlighting(typstEditorHighlight)]),
    resetParserEffect
  };
}


type Props = {
  value: string;
  onChange?: (value: string) => void;
  onDelta?: (changes: EditorChange[]) => EditorDeltaHandlerResult;
  onCursorChange?: (cursor: { line: number; column: number }) => void;
  readOnly?: boolean;
  lineWrap?: boolean;
  language?: "typst" | "latex" | "markdown" | "plain";
  remoteCursors?: RemoteCursor[];
  jumpTo?: { line: number; column: number; token: number } | null;
  onJumpHandled?: () => void;
  editorInstanceKey?: string;
};

export function EditorPane({
  value,
  onChange,
  onDelta,
  onCursorChange,
  readOnly,
  lineWrap = true,
  language = "plain",
  remoteCursors = [],
  jumpTo,
  onJumpHandled,
  editorInstanceKey
}: Props) {
  const editorRef = useRef<EditorView | null>(null);
  const onDeltaRef = useRef<Props["onDelta"]>(onDelta);
  const onChangeRef = useRef<Props["onChange"]>(onChange);
  const onCursorChangeRef = useRef<Props["onCursorChange"]>(onCursorChange);
  const typstLanguage = useMemo(() => buildTypstLanguageSupport(), []);
  const typstResetEffectRef = useRef<StateEffectType<null> | null>(typstLanguage.resetParserEffect);

  useEffect(() => {
    onDeltaRef.current = onDelta;
    onChangeRef.current = onChange;
    onCursorChangeRef.current = onCursorChange;
  }, [onChange, onCursorChange, onDelta]);

  useEffect(() => {
    typstResetEffectRef.current = typstLanguage.resetParserEffect;
  }, [typstLanguage]);

  const cursorListener = useMemo(
    () =>
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (!update.selectionSet) return;
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        onCursorChangeRef.current?.({
          line: line.number,
          column: head - line.from + 1
        });
      }),
    []
  );

  const changeListener = useMemo(
    () =>
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (!update.docChanged) return;
        const hasUserInput = update.transactions.some((transaction) => {
          const event = transaction.annotation(Transaction.userEvent);
          return typeof event === "string";
        });
        if (!hasUserInput) return;
        if (onDeltaRef.current) {
          const changes: EditorChange[] = [];
          update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            changes.push({
              from: fromA,
              to: toA,
              insert: inserted.toString()
            });
          });
          if (changes.length > 0) {
            const accepted = onDeltaRef.current(changes);
            if (accepted === false) {
              update.view.dispatch({
                changes: update.changes.invert(update.startState.doc)
              });
            }
          }
        } else if (onChangeRef.current) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
    []
  );

  const extensions = useMemo(() => {
    const languageExtensions =
      language === "typst"
        ? [typstLanguage.support]
        : language === "latex"
          ? [latex()]
        : language === "markdown"
          ? [markdown()]
          : [];
    const base = [...languageExtensions, cursorListener, changeListener, remoteCursorPlugin];
    if (lineWrap) base.push(EditorView.lineWrapping);
    return base;
  }, [changeListener, cursorListener, language, lineWrap, typstLanguage]);

  useEffect(() => {
    if (language !== "typst") return;
    const view = editorRef.current;
    if (!view) return;
    const resetEffect = typstResetEffectRef.current;
    if (!resetEffect) return;
    view.dispatch({
      effects: resetEffect.of(null)
    });
  }, [language, value]);

  useEffect(() => {
    const view = editorRef.current;
    if (!view) return;
    view.dispatch({
      effects: setRemoteCursorsEffect.of(remoteCursors)
    });
  }, [remoteCursors]);

  useEffect(() => {
    if (!jumpTo) return;
    const view = editorRef.current;
    if (!view) return;
    const lineNo = Math.max(1, Math.min(jumpTo.line, view.state.doc.lines));
    const line = view.state.doc.line(lineNo);
    const column = Math.max(1, Math.min(jumpTo.column, line.length + 1));
    const position = line.from + column - 1;
    view.dispatch({
      selection: { anchor: position },
      scrollIntoView: true
    });
    view.focus();
    onJumpHandled?.();
  }, [jumpTo, onJumpHandled]);

  return (
    <CodeMirror
      key={editorInstanceKey}
      value={value}
      height="100%"
      extensions={extensions}
      onCreateEditor={(view) => {
        editorRef.current = view;
      }}
      onChange={(v) => {
        if (!onDelta && onChange) onChange(v);
      }}
      editable={!readOnly}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true
      }}
      theme="light"
    />
  );
}
