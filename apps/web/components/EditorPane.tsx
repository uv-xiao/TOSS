"use client";

import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";

type Props = {
  value: string;
  onChange: (value: string) => void;
};

export function EditorPane({ value, onChange }: Props) {
  return (
    <CodeMirror
      value={value}
      height="68vh"
      extensions={[markdown()]}
      onChange={(v) => onChange(v)}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true
      }}
      theme="light"
    />
  );
}

