export type UploadCandidate = {
  relativePath: string;
  file: File;
};

async function walkFileEntry(
  entry: any,
  prefix: string,
  output: UploadCandidate[]
): Promise<void> {
  if (!entry) return;
  if (entry.isFile) {
    await new Promise<void>((resolve) => {
      entry.file(
        (file: File) => {
          const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
          output.push({ relativePath, file });
          resolve();
        },
        () => resolve()
      );
    });
    return;
  }
  if (!entry.isDirectory) return;
  const currentPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
  const reader = entry.createReader();
  const entries: any[] = [];
  while (true) {
    const batch = await new Promise<any[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (!batch.length) break;
    entries.push(...batch);
  }
  for (const child of entries) {
    await walkFileEntry(child, currentPrefix, output);
  }
}

export async function collectUploadCandidates(dataTransfer: DataTransfer): Promise<UploadCandidate[]> {
  const output: UploadCandidate[] = [];
  const pending: Array<Promise<void>> = [];
  const itemList = Array.from(dataTransfer.items || []);

  for (const item of itemList) {
    const entry = (item as any).webkitGetAsEntry?.();
    if (entry) {
      pending.push(walkFileEntry(entry, "", output));
    } else {
      const file = item.getAsFile();
      if (!file) continue;
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      output.push({ relativePath, file });
    }
  }
  if (pending.length > 0) {
    await Promise.all(pending);
    return output;
  }
  for (const file of Array.from(dataTransfer.files || [])) {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    output.push({ relativePath, file });
  }
  return output;
}
