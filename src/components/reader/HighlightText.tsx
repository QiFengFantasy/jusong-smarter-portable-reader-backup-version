interface HighlightTextProps {
  text: string;
  term: string;
}

/** 检索命中关键词高亮（不区分大小写，保留原文大小写）。 */
export function HighlightText({ text, term }: HighlightTextProps) {
  const needle = term.trim();
  if (!needle) return <>{text}</>;

  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts: Array<string | JSX.Element> = [];
  let cursor = 0;
  let index = lowerText.indexOf(lowerNeedle);

  while (index !== -1) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(
      <mark key={`hit-${index}`} className="rounded-sm bg-cinnabar/15 px-0.5 text-ink">
        {text.slice(index, index + needle.length)}
      </mark>,
    );
    cursor = index + needle.length;
    index = lowerText.indexOf(lowerNeedle, cursor);
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
