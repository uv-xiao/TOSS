import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView, ViewUpdate } from "@codemirror/view";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onCursorChange?: (cursor: { line: number; column: number }) => void;
  readOnly?: boolean;
};

export function EditorPane({ value, onChange, onCursorChange, readOnly }: Props) {
  const cursorListener = EditorView.updateListener.of((update: ViewUpdate) => {
    if (!update.selectionSet) return;
    const head = update.state.selection.main.head;
    const line = update.state.doc.lineAt(head);
    onCursorChange?.({
      line: line.number,
      column: head - line.from + 1
    });
  });
  return (
    <CodeMirror
      value={value}
      height="68vh"
      extensions={[markdown(), cursorListener]}
      onChange={(v) => onChange(v)}
      editable={!readOnly}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true
      }}
      theme="light"
    />
  );
}
