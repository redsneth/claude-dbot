const LIMIT = 2000;
const SAFE = 1950; // headroom for fence re-opening

/**
 * Split text into Discord-sized chunks, re-opening/closing code fences
 * that span a chunk boundary so formatting survives.
 */
export function chunkMessage(text: string): string[] {
  if (text.length <= LIMIT) return [text];

  const chunks: string[] = [];
  let current = "";
  let openFence: string | null = null;

  const flush = () => {
    if (!current) return;
    chunks.push(openFence ? current + "\n```" : current);
    current = openFence ? openFence + "\n" : "";
  };

  for (const line of text.split("\n")) {
    const fenceMatch = line.match(/^```(\w*)\s*$/);
    if (fenceMatch) openFence = openFence === null ? "```" + (fenceMatch[1] ?? "") : null;

    // A single pathological line longer than the limit gets hard-split.
    if (line.length > SAFE) {
      for (let i = 0; i < line.length; i += SAFE) {
        if (current.length + SAFE > SAFE) flush();
        current += line.slice(i, i + SAFE);
        flush();
      }
      continue;
    }

    if (current.length + line.length + 1 > SAFE) flush();
    current += (current && !current.endsWith("\n") ? "\n" : "") + line;
  }
  if (current.trim()) chunks.push(openFence ? current + "\n```" : current);
  return chunks.filter((c) => c.trim().length > 0);
}
