// Example user plugin: ```timeline fenced blocks → a vertical timeline.
//
// Install: copy this file into the MD Reader plugins folder (Plugins… → Open plugins folder),
// then click "Reload plugins".
//
//   ```timeline
//   2024-01: Project started
//   2024-06: First public release
//   2025: Plugins!
//   ```
//
// Each line is `<when>: <what>` (a leading "- " is allowed). Lines without a colon continue
// the previous entry.

export default {
  id: 'timeline',
  name: 'Timeline',
  description: 'Renders ```timeline blocks ("date: event" per line) as a vertical timeline.',
  version: '1.0.0',
  selector: 'pre > code.language-timeline',

  // Selectors are doubled up (ol.mdr-timeline.mdr-timeline) to win over `.markdown-body ol` rules.
  styles: `
ol.mdr-timeline.mdr-timeline{list-style:none;margin:1em 0 1em .4em;padding:0 0 0 1.4em;border-left:2px solid rgba(127,127,127,.3)}
ol.mdr-timeline.mdr-timeline>li{position:relative;margin:0 0 .9em;padding:0}
ol.mdr-timeline.mdr-timeline>li:last-child{margin-bottom:0}
ol.mdr-timeline.mdr-timeline>li::before{content:"";position:absolute;top:.3em;left:calc(-1.4em - 1px - .35em);width:.7em;height:.7em;
  border-radius:50%;background:var(--md-link,#0969da);box-shadow:0 0 0 3px var(--md-bg,#fff)}
ol.mdr-timeline time{display:block;font-size:.85em;font-weight:600;color:var(--md-muted,#59636e);font-variant-numeric:tabular-nums}
`,

  render(root, ctx) {
    for (const code of root.querySelectorAll(this.selector)) {
      if (!ctx.claim(code)) continue; // already rendered (the reader may run plugins again)

      const items = [];
      for (const raw of code.textContent.split('\n')) {
        const line = raw.replace(/^\s*[-*]\s+/, '').trim();
        if (!line) continue;
        const m = /^([^:]{1,40}):\s*(.*)$/.exec(line);
        if (m) items.push({ when: m[1].trim(), what: m[2] });
        else if (items.length) items[items.length - 1].what += ' ' + line;
        else items.push({ when: '', what: line });
      }
      if (!items.length) {
        ctx.showError(code.parentElement, 'The timeline is empty.', { source: code.textContent });
        continue;
      }

      const ol = document.createElement('ol');
      ol.className = 'mdr-timeline';
      for (const { when, what } of items) {
        const li = document.createElement('li');
        if (when) {
          const time = document.createElement('time');
          time.textContent = when;
          li.append(time);
        }
        li.append(what); // plain text — never innerHTML with document content
        ol.append(li);
      }
      // Replace the whole code block (including the reader's label/copy-button wrapper).
      ctx.codeBlock(code).replaceWith(ol);
    }
  },
};
