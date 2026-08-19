const PREFIX = 'WE_READ_ARCHIVE_PROGRESS ';

export function latestArchiveProgress(output) {
  const lines = String(output || '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith(PREFIX)) continue;
    try {
      const value = JSON.parse(lines[index].slice(PREFIX.length));
      const completed = Math.max(0, Number(value.completed) || 0);
      const total = Math.max(0, Number(value.total) || 0);
      return {
        stage: 'archiving',
        completed: Math.min(completed, total),
        total,
        archived: Math.max(0, Number(value.archived) || 0),
        failed: Math.max(0, Number(value.failed) || 0),
      };
    } catch {
      return null;
    }
  }
  return null;
}
