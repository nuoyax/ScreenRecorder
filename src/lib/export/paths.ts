/**
 * Building output paths on Windows.
 *
 * A recording path arrives from Rust as a `String`, so it may use either separator —
 * `\\?\C:\…` extended-length paths keep their backslashes, and a path the user typed in
 * a text field may use forward slashes. Rather than normalise one into the other (which
 * would break the `\\?\` prefix), both are handled where they occur.
 */

/** Split a path into the part before the last separator and the last segment. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut < 0) return { dir: "", name: path };
  // Keep the separator on the directory, so a root like `C:\` survives the round trip.
  return { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/** Directory an export belongs in: beside the recording it was made from. */
export function exportDirFor(sourcePath: string): string {
  const { dir } = splitPath(sourcePath);
  return dir || ".";
}

/** Join a directory and a file name without doubling or dropping the separator. */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const last = dir[dir.length - 1];
  return last === "/" || last === "\\" ? dir + name : `${dir}\\${name}`;
}

/**
 * File name for an export, derived from the recording.
 *
 * `holiday.mp4` + suffix `-gif` + ext `gif` becomes `holiday-gif.gif`. Leaving the
 * original extension in would produce `holiday.mp4-gif.gif`, which looks like a bug
 * every time the user sees it in a downloads folder.
 */
export function exportNameFor(sourcePath: string, suffix: string, ext: string): string {
  const { name } = splitPath(sourcePath);
  // Only strip a real extension: a recording called `holiday` (no dot) keeps its name,
  // and a leading-dot name like `.hidden` is not an extension either.
  const stem = name.replace(/\.[^.]+$/, "") || name;
  return `${stem}${suffix}.${ext}`;
}
