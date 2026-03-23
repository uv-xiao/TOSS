import CodeMirror from "@uiw/react-codemirror";
import { Transaction } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { Decoration, EditorView, type DecorationSet, type ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { useMemo } from "react";

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


type Props = {
  value: string;
  onChange?: (value: string) => void;
  onDelta?: (changes: EditorChange[]) => void;
  onCursorChange?: (cursor: { line: number; column: number }) => void;
  readOnly?: boolean;
  remoteCursors?: RemoteCursor[];
};

export function EditorPane({
  value,
  onChange,
  onDelta,
  onCursorChange,
  readOnly,
  remoteCursors = []
}: Props) {
  const cursorListener = EditorView.updateListener.of((update: ViewUpdate) => {
    if (!update.selectionSet) return;
    const head = update.state.selection.main.head;
    const line = update.state.doc.lineAt(head);
    onCursorChange?.({
      line: line.number,
      column: head - line.from + 1
    });
  });

  const changeListener = EditorView.updateListener.of((update: ViewUpdate) => {
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
  });

  const remoteCursorExtension = useMemo(
    () => EditorView.decorations.of((view) => buildRemoteCursorDecorations(view, remoteCursors)),
    [remoteCursors]
  );

  return (
    <CodeMirror
      value={value}
      height="100%"
      extensions={[markdown(), cursorListener, changeListener, remoteCursorExtension]}
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
