export function formatDuration(secs: number): string {
  const t = Math.max(0, Math.floor(secs));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function parentDir(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, "");
}
