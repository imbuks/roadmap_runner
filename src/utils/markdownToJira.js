// Convert Markdown to Jira (Server/DC) wiki markup.
// Best-effort converter for the common constructs; Jira's REST v2 `description`
// field renders wiki markup, not Markdown.
export function markdownToJira(md) {
  if (!md) return '';
  let s = String(md).replace(/\r\n/g, '\n');

  // Stash protected fragments (code, pre-converted bold) so later passes skip
  // them. A private-use delimiter avoids collisions with real text.
  const stash = [];
  const D = String.fromCharCode(0xE000);
  const stashPush = (val) => `${D}${stash.push(val) - 1}${D}`;
  const restoreRe = new RegExp(`${D}(\\d+)${D}`, 'g');

  // Fenced code blocks: ```lang\n...\n```  ->  {code:lang}...{code}
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
    const l = lang ? `:${lang}` : '';
    return stashPush(`{code${l}}\n${code.replace(/\n$/, '')}\n{code}`);
  });
  // Inline code: `x` -> {{x}}
  s = s.replace(/`([^`\n]+)`/g, (m, code) => stashPush(`{{${code}}}`));

  // Images before links: ![alt](url) -> !url!
  s = s.replace(/!\[[^\]]*\]\(([^)]+)\)/g, '!$1!');
  // Links: [text](url) -> [text|url]
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]');

  // Headings: #..###### -> h1..h6.
  s = s.replace(/^\s{0,3}######\s+(.*)$/gm, 'h6. $1')
    .replace(/^\s{0,3}#####\s+(.*)$/gm, 'h5. $1')
    .replace(/^\s{0,3}####\s+(.*)$/gm, 'h4. $1')
    .replace(/^\s{0,3}###\s+(.*)$/gm, 'h3. $1')
    .replace(/^\s{0,3}##\s+(.*)$/gm, 'h2. $1')
    .replace(/^\s{0,3}#\s+(.*)$/gm, 'h1. $1');

  // Bold: **x** or __x__ -> *x* (stashed so italic/list passes leave it alone)
  s = s.replace(/\*\*([^*]+)\*\*/g, (m, t) => stashPush(`*${t}*`));
  s = s.replace(/__([^_]+)__/g, (m, t) => stashPush(`*${t}*`));

  // Italic: *x* -> _x_
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1_$2_');

  // Strikethrough: ~~x~~ -> -x-
  s = s.replace(/~~([^~]+)~~/g, '-$1-');

  // Blockquote: > x -> bq. x
  s = s.replace(/^\s*>\s?(.*)$/gm, 'bq. $1');

  // Ordered list items: 1. item -> # item
  s = s.replace(/^\s*\d+\.\s+/gm, '# ');
  // Unordered list items: -, *, + item -> * item
  s = s.replace(/^\s*[-*+]\s+/gm, '* ');

  // Horizontal rule: --- or *** -> ----
  s = s.replace(/^\s*(-{3,}|\*{3,})\s*$/gm, '----');

  // Restore stashed fragments
  s = s.replace(restoreRe, (m, i) => stash[Number(i)]);
  return s;
}
