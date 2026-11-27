type SaveHandle = {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
};
type SavePicker = (options: { suggestedName: string }) => Promise<SaveHandle>;

export type SaveResult =
  | { status: "saved" }
  | { status: "cancelled" }
  | { status: "ready"; file: File };

/** Hands a file to the browser's normal download flow. */
export function downloadFile(file: File) {
  const objectUrl = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = file.name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers start large media downloads asynchronously after the click.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/**
 * Opens a native save dialog before fetching when available. Otherwise returns the prepared file
 * so the UI can start a browser download from a fresh user tap.
 */
export async function saveWithPicker(suggestedName: string, getFile: () => Promise<File>): Promise<SaveResult> {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) return { status: "ready", file: await getFile() };

  let handle: SaveHandle;
  try {
    // Must come before any fetching: the dialog is only allowed right after the click.
    handle = await picker.call(window, { suggestedName });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return { status: "cancelled" };
    // Let the user retry from a fresh tap when the browser blocks the save dialog.
    return { status: "ready", file: await getFile() };
  }

  const file = await getFile();
  try {
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
    return { status: "saved" };
  } catch {
    // Keep the fetched file available for a normal browser download retry.
    return { status: "ready", file };
  }
}
