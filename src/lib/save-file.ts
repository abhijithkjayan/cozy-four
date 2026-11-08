type SaveHandle = {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
};
type SavePicker = (options: { suggestedName: string }) => Promise<SaveHandle>;

/** Hands a file to the browser's normal download flow. */
export function downloadFile(file: File) {
  const objectUrl = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

/**
 * Asks where to save, then fetches and writes the file there. Browsers without a save dialog
 * API (Safari, Firefox, most phones) use a normal download instead.
 * Returns true only when the file was written to the place the user chose.
 */
export async function saveWithPicker(suggestedName: string, getFile: () => Promise<File>) {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  let handle: SaveHandle | undefined;
  if (picker) {
    try {
      // Must come before any fetching: the dialog is only allowed right after the click.
      handle = await picker.call(window, { suggestedName });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return false; // user cancelled
      // Otherwise the dialog was blocked (for example inside an iframe), so download normally.
    }
  }
  const file = await getFile();
  if (!handle) {
    downloadFile(file);
    return false;
  }
  const writable = await handle.createWritable();
  await writable.write(file);
  await writable.close();
  return true;
}
