export interface OutputDisplay {
  label?: string;
  bounds: { x: number; y: number };
}

export function normalizeOutputLabel(label: string | undefined): string | undefined {
  return label?.trim().replace(/^\((.*)\)$/, "$1") || undefined;
}

/** Preserve each output's local position when its global origin changes. */
export function rememberOutputPosition(
  positions: Record<string, { x: number; y: number }> | undefined,
  position: { x: number; y: number },
  output: string | undefined,
  displays: OutputDisplay[],
): Record<string, { x: number; y: number }> {
  const next = { ...positions };
  const display = output && displays.find((item) => normalizeOutputLabel(item.label) === output);
  if (output && display) next[output] = {
    x: position.x - display.bounds.x, y: position.y - display.bounds.y,
  };
  return next;
}
