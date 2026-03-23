import CodeMirror from "@uiw/react-codemirror";
import { StateEffect, Transaction } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from "@codemirror/language";
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

export type EditorChange = {
  from: number;
  to: number;
  insert: string;
};

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

type TypstState = {
  inString: '"' | "'" | null;
};

const typstKeywords = new Set([
  "set",
  "show",
  "let",
  "if",
  "else",
  "for",
  "while",
  "in",
  "break",
  "continue",
  "return",
  "import",
  "include",
  "as",
  "and",
  "or",
  "not",
  "none",
  "auto",
  "true",
  "false"
]);

const typstParser: StreamParser<TypstState> = {
  startState() {
    return { inString: null };
  },
  token(stream, state) {
    if (state.inString) {
      let escaped = false;
      while (!stream.eol()) {
        const ch = stream.next();
        if (!ch) break;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === state.inString) {
          state.inString = null;
          break;
        }
      }
      return "string";
    }

    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;

    const quote = stream.peek();
    if (quote === '"' || quote === "'") {
      state.inString = quote;
      stream.next();
      return "string";
    }

    if (stream.match(/#[A-Za-z_][\w-]*/)) return "keyword";
    if (stream.match(/[0-9]+(\.[0-9]+)?/)) return "number";
    if (stream.match(/[+\-*/=<>!]+/)) return "operator";
    if (stream.match(/[:.,()[\]{}]/)) return "punctuation";
    if (stream.match(/[A-Za-z_][\w-]*/)) {
      const word = stream.current();
      if (typstKeywords.has(word)) return "keyword";
      if (stream.peek() === "(") return "function";
      return "variableName";
    }
    stream.next();
    return null;
  },
  languageData: {
    commentTokens: { line: "//" }
  }
};

const typstHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#7c3aed", fontWeight: "600" },
  { tag: tags.comment, color: "#4b5563", fontStyle: "italic" },
  { tag: tags.string, color: "#047857" },
  { tag: tags.number, color: "#b45309" },
  { tag: [tags.variableName, tags.name], color: "#1f2937" },
  { tag: tags.function(tags.variableName), color: "#0369a1" },
  { tag: tags.operator, color: "#0f172a" }
]);


type Props = {
  value: string;
  onChange?: (value: string) => void;
  onDelta?: (changes: EditorChange[]) => void;
  onCursorChange?: (cursor: { line: number; column: number }) => void;
  readOnly?: boolean;
  lineWrap?: boolean;
  language?: "typst" | "markdown" | "plain";
  remoteCursors?: RemoteCursor[];
  jumpTo?: { line: number; column: number; token: number } | null;
  onJumpHandled?: () => void;
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
  onJumpHandled
}: Props) {
  const editorRef = useRef<EditorView | null>(null);

  const cursorListener = useMemo(
    () =>
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (!update.selectionSet) return;
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        onCursorChange?.({
          line: line.number,
          column: head - line.from + 1
        });
      }),
    [onCursorChange]
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
        if (onDelta) {
          const changes: EditorChange[] = [];
          update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            changes.push({
              from: fromA,
              to: toA,
              insert: inserted.toString()
            });
          });
          if (changes.length > 0) onDelta(changes);
        } else if (onChange) {
          onChange(update.state.doc.toString());
        }
      }),
    [onChange, onDelta]
  );

  const extensions = useMemo(() => {
    const languageExtension =
      language === "typst"
        ? StreamLanguage.define(typstParser)
        : language === "markdown"
          ? markdown()
          : [];
    const base = [languageExtension, syntaxHighlighting(typstHighlight), cursorListener, changeListener, remoteCursorPlugin];
    if (lineWrap) base.push(EditorView.lineWrapping);
    return base;
  }, [changeListener, cursorListener, language, lineWrap]);

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
