// Convert Jira (Server/DC) wiki markup to Markdown, so the wiki source can be
// previewed with the same Markdown renderer the other description formats use.
// Best-effort, and deliberately the mirror image of markdownToJira.
export function jiraToMarkdown(wiki) {
  if (!wiki) return '';
  let s = String(wiki).replace(/\r\n/g, '\n');

  // Stash fragments that later passes must not touch (code, converted bold).
  // A private-use delimiter avoids collisions with real text.
  const stash = [];
  const D = String.fromCharCode(0xE000);
  const stashPush = (val) => `${D}${stash.push(val) - 1}${D}`;
  const restoreRe = new RegExp(`${D}(\\d+)${D}`, 'g');

  // Block code first, so nothing inside it is read as markup.
  // {code:java} and {code:title=X|language=java} both carry the language.
  // The braces around the markers are matched loosely so that inline code —
  // {{code}} — is neither mistaken for a block nor allowed to close one early.
  s = s.replace(/(^|[^{])\{code(?::([^}]*))?\}\n?([\s\S]*?)\n?\{code\}(?!\})/g, (m, pre, attrs, code) => {
    const parts = (attrs || '').split('|').filter(Boolean);
    const named = parts.find(p => p.startsWith('language='));
    const bare = parts.find(p => !p.includes('='));
    const lang = named ? named.slice('language='.length) : (bare || '');
    return pre + stashPush(`\`\`\`${lang}\n${code}\n\`\`\``);
  });
  s = s.replace(/(^|[^{])\{noformat(?::[^}]*)?\}\n?([\s\S]*?)\n?\{noformat\}(?!\})/g,
    (m, pre, code) => pre + stashPush(`\`\`\`\n${code}\n\`\`\``));

  // {quote}...{quote} -> a blockquote over every line it covers
  s = s.replace(/\{quote\}\n?([\s\S]*?)\n?\{quote\}/g,
    (m, body) => body.split('\n').map(l => `> ${l}`).join('\n'));

  // Panels keep their title as a bold first line inside a blockquote
  s = s.replace(/\{panel(?::([^}]*))?\}\n?([\s\S]*?)\n?\{panel\}/g, (m, attrs, body) => {
    const title = /title=([^|}]*)/.exec(attrs || '');
    const lines = body.split('\n');
    if (title) lines.unshift(`**${title[1]}**`, '');
    return lines.map(l => `> ${l}`).join('\n');
  });

  // Inline code: {{x}} -> `x`
  s = s.replace(/\{\{([^}\n]+)\}\}/g, (m, code) => stashPush(`\`${code}\``));

  // Markup Markdown has no equivalent for: keep the text, drop the wrapper
  s = s.replace(/\{color:[^}]*\}([\s\S]*?)\{color\}/g, '$1');
  s = s.replace(/\{anchor:[^}]*\}/g, '');
  // User mentions: [~jdoe] -> @jdoe
  s = s.replace(/\[~([^\]]+)\]/g, '@$1');

  // Lists before headings and the inline passes: leading * markers must be gone
  // before bold is matched, and the # they turn into must not be read as a heading.
  // Depth is the length of the marker run, so ** and #* are nested items.
  s = s.replace(/^([*#]+)\s+(.*)$/gm, (m, markers, text) => {
    const indent = '  '.repeat(markers.length - 1);
    const bullet = markers[markers.length - 1] === '#' ? '1. ' : '- ';
    return `${indent}${bullet}${text}`;
  });

  // Headings: h1. .. h6. -> #..######
  s = s.replace(/^h([1-6])\.\s+(.*)$/gm, (m, level, text) => `${'#'.repeat(Number(level))} ${text}`);

  // Tables: ||header||header|| and |cell|cell| blocks.
  // Markdown needs a separator row, so a table with no header row gets a blank one.
  s = s.replace(/(^\|.*\|[ \t]*$\n?)+/gm, (block) => {
    const rows = block.trimEnd().split('\n').map(line => {
      const header = line.trimStart().startsWith('||');
      const cells = line.trim().replace(/^\|\|?/, '').replace(/\|\|?$/, '')
        .split(header ? '||' : '|').map(c => c.trim());
      return { header, cells };
    });
    const width = Math.max(...rows.map(r => r.cells.length));
    const render = (cells) => `| ${Array.from({ length: width }, (_, i) => cells[i] || '').join(' | ')} |`;
    const separator = `|${' --- |'.repeat(width)}`;
    const out = [];
    if (rows[0].header) {
      out.push(render(rows[0].cells), separator);
      rows.slice(1).forEach(r => out.push(render(r.cells)));
    } else {
      out.push(render([]), separator);
      rows.forEach(r => out.push(render(r.cells)));
    }
    return `${out.join('\n')}\n`;
  });

  // Blockquote: bq. x -> > x
  s = s.replace(/^bq\.\s?(.*)$/gm, '> $1');

  // Horizontal rule
  s = s.replace(/^[ \t]*-{4,}[ \t]*$/gm, '---');

  // Images before links, since both use brackets/bangs
  s = s.replace(/!([^!\s|]+)(?:\|[^!]*)?!/g, '![]($1)');
  // Links: [text|url] -> [text](url), bare [url] -> <url>
  s = s.replace(/\[([^\]|]+)\|([^\]]+)\]/g, '[$1]($2)');
  s = s.replace(/\[((?:https?|mailto):[^\]]+)\]/g, '<$1>');

  // Bold: *x* -> **x** (stashed so the italic pass leaves the new markers alone)
  s = s.replace(/(^|[\s([{])\*([^*\n]+)\*(?=$|[\s.,;:!?)\]}])/gm,
    (m, pre, text) => pre + stashPush(`**${text}**`));
  // Italic: _x_ -> *x*
  s = s.replace(/(^|[\s([{])_([^_\n]+)_(?=$|[\s.,;:!?)\]}])/gm, '$1*$2*');
  // Strikethrough: -x- -> ~~x~~. Bounded by whitespace so hyphenated words survive.
  s = s.replace(/(^|\s)-([^-\n]+)-(?=$|[\s.,;:!?)\]}])/gm, '$1~~$2~~');
  // Underline and monospace-by-plus have no Markdown form; keep the text
  s = s.replace(/(^|[\s([{])\+([^+\n]+)\+(?=$|[\s.,;:!?)\]}])/gm, '$1$2');

  // Restore stashed fragments
  s = s.replace(restoreRe, (m, i) => stash[Number(i)]);
  return s;
}

export default jiraToMarkdown;
