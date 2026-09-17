// Zen Easel — Markdown for text boxes.
//
// A text box with text.markdown set keeps its content as Markdown source (the textarea
// edits that source) and is painted as rendered Markdown by the canvas. This module is
// the pure half: parse() turns source into blocks, layout() turns blocks into positioned
// runs and decorations in object-local pixels, and layoutFor() caches both per object.
// No DOM, no HTML: the source is untrusted board data, so tags stay literal text and
// every link goes through safeExternalUrl before it can be a link at all.

"use strict";

(function () {
    if (window.ZenEaselMarkdown) return;

    const MAX_NESTING = 16;
    const MAX_TABLE_COLUMNS = 32;
    const MONO = '"Zen Easel Inconsolata", ui-monospace, monospace';
    // Type ramp relative to the box's fontSize, which is the body size.
    const HEADING_SCALE = [0, 2, 1.5, 1.25, 1.1, 1, 0.9];
    const CODE_SCALE = 0.9;
    const BULLETS = ["•", "◦", "▪"];

    const ENTITIES = {
        amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", copy: "©",
        reg: "®", trade: "™", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»",
        ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", middot: "·", bull: "•"
    };

    /* ================================================================= blocks */

    const RE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)/;
    const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
    const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
    const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
    const RE_QUOTE = /^ {0,3}> ?/;
    const RE_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])( {1,4}|$)/;
    const RE_TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
    const RE_TASK = /^\[([ xX])\][ \t]+/;

    const isBlank = line => !/\S/.test(line);
    const indentOf = line => line.match(/^ */)[0].length;

    // Whether a line would start a new block, used to end lazy paragraph continuation.
    function startsBlock(line) {
        return RE_FENCE.test(line) || RE_ATX.test(line) || RE_HR.test(line) ||
            RE_QUOTE.test(line) || RE_ITEM.test(line);
    }

    function parse(source) {
        const text = String(source || "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
        return parseBlocks(text.split("\n"), 0);
    }

    function parseBlocks(lines, depth) {
        const blocks = [];
        let i = 0;
        let para = null;

        const flushPara = () => {
            if (!para) return;
            blocks.push({ type: "paragraph", inlines: parseInlines(para.join("\n")) });
            para = null;
        };

        while (i < lines.length) {
            const line = lines[i];

            if (isBlank(line)) { flushPara(); i++; continue; }

            // Setext heading: a paragraph followed by === or ---.
            if (para && RE_SETEXT.test(line)) {
                const level = line.trim()[0] === "=" ? 1 : 2;
                blocks.push({ type: "heading", level, inlines: parseInlines(para.join("\n")) });
                para = null;
                i++;
                continue;
            }

            // Indented code, only when not continuing a paragraph.
            if (!para && indentOf(line) >= 4) {
                const body = [];
                while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) {
                    body.push(lines[i].slice(4));
                    i++;
                }
                while (body.length && isBlank(body[body.length - 1])) body.pop();
                blocks.push({ type: "code", lang: "", text: body.join("\n") });
                continue;
            }

            const fence = line.match(RE_FENCE);
            if (fence) {
                flushPara();
                const marker = fence[1];
                const body = [];
                i++;
                while (i < lines.length) {
                    const close = lines[i].match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
                    if (close && close[1][0] === marker[0] && close[1].length >= marker.length) { i++; break; }
                    body.push(lines[i]);
                    i++;
                }
                blocks.push({ type: "code", lang: fence[2] || "", text: body.join("\n") });
                continue;
            }

            const atx = line.match(RE_ATX);
            if (atx) {
                flushPara();
                const content = line.slice(atx[0].length).replace(/[ \t]+#+[ \t]*$/, "").replace(/^#+[ \t]*$/, "").trim();
                blocks.push({ type: "heading", level: atx[1].length, inlines: parseInlines(content) });
                i++;
                continue;
            }

            if (RE_HR.test(line)) {
                flushPara();
                blocks.push({ type: "hr" });
                i++;
                continue;
            }

            if (RE_QUOTE.test(line) && depth < MAX_NESTING) {
                flushPara();
                const inner = [];
                let lazy = false;
                while (i < lines.length) {
                    const l = lines[i];
                    if (RE_QUOTE.test(l)) {
                        inner.push(l.replace(RE_QUOTE, ""));
                        lazy = !isBlank(inner[inner.length - 1]) && !startsBlock(inner[inner.length - 1]);
                    } else if (lazy && !isBlank(l) && !startsBlock(l)) {
                        inner.push(l);
                    } else {
                        break;
                    }
                    i++;
                }
                blocks.push({ type: "blockquote", blocks: parseBlocks(inner, depth + 1) });
                continue;
            }

            // Only a bullet or a list starting at 1 may interrupt a paragraph, so "1986. A year" stays prose.
            const item = line.match(RE_ITEM);
            if (item && depth < MAX_NESTING && (!para || !/\d/.test(item[2]) || /^1[.)]$/.test(item[2]))) {
                flushPara();
                i = parseList(lines, i, depth, blocks);
                continue;
            }

            // A GFM table needs a header row and a delimiter row with the same column count.
            if (line.includes("|") && i + 1 < lines.length && RE_TABLE_DELIM.test(lines[i + 1])) {
                const head = splitRow(line);
                const delims = splitRow(lines[i + 1]);
                if (head.length === delims.length && head.length <= MAX_TABLE_COLUMNS) {
                    flushPara();
                    const align = delims.map(d => {
                        const t = d.trim();
                        const left = t.startsWith(":"), right = t.endsWith(":");
                        return left && right ? "center" : right ? "right" : "left";
                    });
                    const rows = [];
                    i += 2;
                    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) {
                        const cells = splitRow(lines[i]).slice(0, head.length);
                        while (cells.length < head.length) cells.push("");
                        rows.push(cells.map(parseInlines));
                        i++;
                    }
                    blocks.push({ type: "table", align, head: head.map(parseInlines), rows });
                    continue;
                }
            }

            // Trailing spaces are kept: two of them before the newline are a hard break.
            if (!para) para = [];
            para.push(line.replace(/^\s+/, ""));
            i++;
        }

        flushPara();
        return blocks;
    }

    // Splits a pipe row into cell strings, honouring \| and leading/trailing pipes.
    function splitRow(line) {
        let s = line.trim();
        if (s.startsWith("|")) s = s.slice(1);
        if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
        const cells = [];
        let cur = "";
        let code = false;
        for (let k = 0; k < s.length; k++) {
            const c = s[k];
            if (c === "\\" && s[k + 1] === "|") { cur += "|"; k++; continue; }
            if (c === "`") code = !code;
            if (c === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
            cur += c;
        }
        cells.push(cur.trim());
        return cells;
    }

    // Consumes one list starting at lines[start]; returns the index after it.
    function parseList(lines, start, depth, blocks) {
        const first = lines[start].match(RE_ITEM);
        const ordered = /\d/.test(first[2]);
        const bulletChar = ordered ? first[2].slice(-1) : first[2];
        const items = [];
        let i = start;

        while (i < lines.length) {
            const m = lines[i].match(RE_ITEM);
            if (!m) break;
            const sameKind = ordered ? /\d/.test(m[2]) && m[2].slice(-1) === bulletChar : m[2] === bulletChar;
            if (!sameKind) break;

            // Content indent; five or more spaces means one space plus indented code.
            const spaces = m[3].length > 4 || m[3].length === 0 ? 1 : m[3].length;
            const contentIndent = m[1].length + m[2].length + spaces;
            const inner = [lines[i].slice(m[1].length + m[2].length + spaces)];
            i++;

            let lazy = !isBlank(inner[0]) && !startsBlock(inner[0]);
            while (i < lines.length) {
                const l = lines[i];
                if (isBlank(l)) {
                    // A blank line stays inside the item only if indented content follows.
                    let j = i + 1;
                    while (j < lines.length && isBlank(lines[j])) j++;
                    if (j < lines.length && indentOf(lines[j]) >= contentIndent) { inner.push(""); i++; lazy = false; continue; }
                    break;
                }
                if (indentOf(l) >= contentIndent) {
                    inner.push(l.slice(contentIndent));
                    lazy = !startsBlock(inner[inner.length - 1]);
                    i++;
                    continue;
                }
                if (lazy && !startsBlock(l)) { inner.push(l.trim()); i++; continue; }
                break;
            }

            let checked = null;
            const task = inner[0].match(RE_TASK);
            if (task) { checked = task[1] !== " "; inner[0] = inner[0].slice(task[0].length); }

            items.push({ checked, blocks: parseBlocks(inner, depth + 1) });

            // A list ends at a blank line that is not followed by another item of it.
            let j = i;
            while (j < lines.length && isBlank(lines[j])) j++;
            if (j > i) {
                if (!(j < lines.length && RE_ITEM.test(lines[j]))) break;
                i = j;
            }
        }

        const startNum = ordered ? parseInt(first[2], 10) : 1;
        blocks.push({ type: "list", ordered, start: Number.isFinite(startNum) ? startNum : 1, items });
        return i;
    }

    /* ================================================================ inlines */

    const isWs = c => c === undefined || c === "" || /\s/.test(c);
    const isPunct = c => c !== undefined && /[!-\/:-@\[-`{-~¡-¿‐-‧‰-⁞]/.test(c);

    function parseInlines(src) {
        return flattenInlines(parseInlineNodes(src));
    }

    // Delimiter-run inline parser (CommonMark's algorithm, hand-scanned, no regex backtracking).
    function parseInlineNodes(src) {
        const nodes = [];
        let buf = "";
        const flush = () => { if (buf) { nodes.push({ t: "text", s: buf }); buf = ""; } };
        const n = src.length;
        let i = 0;

        while (i < n) {
            const c = src[i];

            if (c === "\\") {
                const next = src[i + 1];
                if (next === "\n") { flush(); nodes.push({ t: "br" }); i += 2; continue; }
                if (next !== undefined && isPunct(next) && next.charCodeAt(0) < 128) { buf += next; i += 2; continue; }
                buf += c; i++; continue;
            }

            if (c === "\n") {
                const trimmed = buf.replace(/ +$/, "");
                const hard = buf.length - trimmed.length >= 2;
                buf = trimmed;
                flush();
                nodes.push(hard ? { t: "br" } : { t: "text", s: " " });
                i++;
                continue;
            }

            if (c === "`") {
                let run = 1;
                while (src[i + run] === "`") run++;
                let close = -1;
                let k = i + run;
                while (k < n) {
                    if (src[k] !== "`") { k++; continue; }
                    let len = 0;
                    while (src[k + len] === "`") len++;
                    if (len === run) { close = k; break; }
                    k += len;
                }
                if (close < 0) { buf += src.slice(i, i + run); i += run; continue; }
                let code = src.slice(i + run, close).replace(/\n/g, " ");
                if (code.length > 2 && code[0] === " " && code[code.length - 1] === " " && /\S/.test(code)) code = code.slice(1, -1);
                flush();
                nodes.push({ t: "code", s: code });
                i = close + run;
                continue;
            }

            if (c === "&") {
                const m = /^&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/i.exec(src.slice(i, i + 12));
                if (m) {
                    let ch = null;
                    const name = m[1];
                    if (name[0] === "#") {
                        const cp = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
                        if (cp > 0 && cp <= 0x10ffff) ch = String.fromCodePoint(cp);
                    } else if (ENTITIES[name]) {
                        ch = ENTITIES[name];
                    }
                    if (ch !== null) { buf += ch; i += m[0].length; continue; }
                }
                buf += c; i++; continue;
            }

            if (c === "<") {
                const m = /^<(https?:\/\/[^\s<>]+)>/.exec(src.slice(i, i + 2100));
                if (m) {
                    flush();
                    pushLink(nodes, m[1], [{ t: "text", s: m[1] }]);
                    i += m[0].length;
                    continue;
                }
                buf += c; i++; continue;
            }

            if (c === "[" || (c === "!" && src[i + 1] === "[")) {
                const link = scanLink(src, c === "!" ? i + 1 : i);
                if (link) {
                    flush();
                    pushLink(nodes, link.href, parseInlineNodes(link.label));
                    i = link.end;
                    continue;
                }
                buf += c; i++; continue;
            }

            if ((c === "h" || c === "w") && (i === 0 || !/[\w\/]/.test(src[i - 1]))) {
                const m = /^(?:https?:\/\/|www\.)[^\s<]+/.exec(src.slice(i, i + 2100));
                if (m) {
                    let url = m[0].replace(/[.,:;!?'"]+$/, "");
                    while (url.endsWith(")") && (url.split("(").length - 1) < (url.split(")").length - 1)) url = url.slice(0, -1);
                    if (url.length > 4) {
                        flush();
                        pushLink(nodes, url.startsWith("www.") ? `https://${url}` : url, [{ t: "text", s: url }]);
                        i += url.length;
                        continue;
                    }
                }
            }

            if (c === "*" || c === "_" || c === "~") {
                let run = 1;
                while (src[i + run] === c) run++;
                const prev = src[i - 1], next = src[i + run];
                const left = !isWs(next) && (!isPunct(next) || isWs(prev) || isPunct(prev));
                const right = !isWs(prev) && (!isPunct(prev) || isWs(next) || isPunct(next));
                let open = left, close = right;
                if (c === "_") { open = left && (!right || isPunct(prev)); close = right && (!left || isPunct(next)); }
                if (c === "~" && run !== 2) { open = false; close = false; }
                flush();
                nodes.push({ t: "delim", ch: c, n: run, open, close });
                i += run;
                continue;
            }

            buf += c;
            i++;
        }
        flush();
        return processEmphasis(nodes);
    }

    function pushLink(nodes, href, children) {
        const safe = window.ZenEaselObjects.safeExternalUrl(href);
        if (safe) nodes.push({ t: "link", href: safe, nodes: children });
        else nodes.push(...children);
    }

    // [label](destination "title") at src[start] === "["; null when it is not a link.
    function scanLink(src, start) {
        let depth = 0;
        let k = start;
        let close = -1;
        while (k < src.length) {
            const c = src[k];
            if (c === "\\") { k += 2; continue; }
            if (c === "`") {
                let run = 1;
                while (src[k + run] === "`") run++;
                let e = src.indexOf("`".repeat(run), k + run);
                k = e < 0 ? k + run : e + run;
                continue;
            }
            if (c === "[") depth++;
            else if (c === "]") { depth--; if (depth === 0) { close = k; break; } }
            k++;
        }
        if (close < 0 || src[close + 1] !== "(") return null;

        k = close + 2;
        while (k < src.length && /[ \n]/.test(src[k])) k++;
        let href = "";
        if (src[k] === "<") {
            const e = src.indexOf(">", k + 1);
            if (e < 0) return null;
            href = src.slice(k + 1, e);
            k = e + 1;
        } else {
            let parens = 0;
            const s = k;
            while (k < src.length && !/\s/.test(src[k])) {
                if (src[k] === "\\") { k += 2; continue; }
                if (src[k] === "(") parens++;
                else if (src[k] === ")") { if (parens === 0) break; parens--; }
                k++;
            }
            href = src.slice(s, k);
        }
        while (k < src.length && /[ \n]/.test(src[k])) k++;
        const q = src[k];
        if (q === "\"" || q === "'") {
            const e = src.indexOf(q, k + 1);
            if (e < 0) return null;
            k = e + 1;
            while (k < src.length && /[ \n]/.test(src[k])) k++;
        }
        if (src[k] !== ")") return null;
        return { label: src.slice(start + 1, close), href: href.replace(/\\([!-\/:-@\[-`{-~])/g, "$1"), end: k + 1 };
    }

    // Runs over a linked list rather than splicing an array, so 100 KB of **bold** is linear.
    function processEmphasis(nodes) {
        let head = null, tail = null;
        for (const n of nodes) {
            n.prev = tail; n.next = null;
            if (tail) tail.next = n; else head = n;
            tail = n;
        }
        const unlink = n => {
            if (n.prev) n.prev.next = n.next; else head = n.next;
            if (n.next) n.next.prev = n.prev;
        };

        const openers = [];
        // CommonMark's openers_bottom, keyed by char, can-open and length mod 3 as the spec has it.
        const bottom = new Map();
        const keyOf = n => `${n.ch}${n.open ? 1 : 0}${n.n % 3}`;
        let node = head;
        while (node) {
            if (node.t !== "delim") { node = node.next; continue; }
            if (!node.close) { if (node.open) openers.push(node); node = node.next; continue; }

            let matched = false;
            const floor = Math.min(bottom.get(keyOf(node)) || 0, openers.length);
            for (let o = openers.length - 1; o >= floor; o--) {
                const opener = openers[o];
                if (opener.ch !== node.ch) continue;
                // Rule of three, so *foo**bar* cannot pair the inner pair across the outer.
                if ((opener.close || node.open) && (opener.n + node.n) % 3 === 0 && !(opener.n % 3 === 0 && node.n % 3 === 0)) continue;

                const use = node.ch === "~" ? 2 : (opener.n >= 2 && node.n >= 2 ? 2 : 1);
                const type = node.ch === "~" ? "del" : use === 2 ? "strong" : "em";
                const inner = [];
                for (let c = opener.next; c !== node; c = c.next) inner.push(c);
                const wrapped = { t: type, nodes: inner, prev: opener, next: node };
                opener.next = wrapped;
                node.prev = wrapped;
                opener.n -= use;
                node.n -= use;
                openers.length = o + 1;
                if (opener.n === 0) { unlink(opener); openers.pop(); }
                for (const [k, v] of bottom) if (v > openers.length) bottom.set(k, openers.length);
                if (node.n === 0) { const next = node.next; unlink(node); node = next; }
                matched = true;
                break;
            }
            if (!matched) {
                bottom.set(keyOf(node), openers.length);
                if (node.open) openers.push(node);
                node = node.next;
            }
        }

        const out = [];
        for (let n = head; n; n = n.next) out.push(n);
        return out;
    }

    // Tree → flat runs { text, bold, italic, strike, code, link, br }.
    function flattenInlines(nodes) {
        const runs = [];
        const walk = (list, style) => {
            for (const node of list) {
                switch (node.t) {
                    case "text": pushRun(runs, { ...style, text: node.s }); break;
                    case "delim": pushRun(runs, { ...style, text: node.ch.repeat(node.n) }); break;
                    case "code": runs.push({ ...style, code: true, text: node.s }); break;
                    case "br": runs.push({ br: true }); break;
                    case "link": walk(node.nodes, { ...style, link: node.href }); break;
                    case "strong": walk(node.nodes, { ...style, bold: true }); break;
                    case "em": walk(node.nodes, { ...style, italic: true }); break;
                    case "del": walk(node.nodes, { ...style, strike: true }); break;
                }
            }
        };
        walk(nodes, { bold: false, italic: false, strike: false, code: false, link: null });
        return runs;
    }

    // Merges adjacent plain runs of the same style so wrapping sees whole words.
    function pushRun(runs, run) {
        const last = runs[runs.length - 1];
        if (last && !last.br && !last.code && !run.code && last.bold === run.bold && last.italic === run.italic &&
            last.strike === run.strike && last.link === run.link) {
            last.text += run.text;
        } else {
            runs.push(run);
        }
    }

    /* ================================================================= layout */

    // opts: { width, fontSize, fontCss, align, lineHeight, padX, padY }. Everything is
    // in object-local pixels; colours are resolved by the renderer at draw time.
    function layout(ctx, blocks, opts) {
        const base = opts.fontSize;
        const out = { lines: [], decorations: [], links: [], fonts: new Set(), height: 0 };
        const state = { ctx, opts, out, y: opts.padY };

        layoutBlocks(state, blocks, opts.padX, Math.max(opts.width - opts.padX * 2, 1), 0, base * 0.5);

        const minHeight = base * opts.lineHeight + opts.padY * 2;
        out.height = Math.max(state.y + opts.padY, minHeight);
        return out;
    }

    function fontFor(state, run, px) {
        const family = run.code ? MONO : state.opts.fontCss;
        const font = `${run.italic ? "italic " : ""}${run.bold ? "700 " : ""}${px}px ${family}`;
        state.out.fonts.add(font);
        return font;
    }

    function layoutBlocks(state, blocks, x, w, depth, gap) {
        for (let b = 0; b < blocks.length; b++) {
            if (b > 0) state.y += gap;
            layoutBlock(state, blocks[b], x, w, depth, gap);
        }
    }

    function layoutBlock(state, block, x, w, depth, gap) {
        const base = state.opts.fontSize;
        switch (block.type) {
            case "paragraph":
                layoutInlines(state, block.inlines, x, w, base, false, state.opts.align);
                break;
            case "heading":
                layoutInlines(state, block.inlines, x, w, base * HEADING_SCALE[block.level] || base, true, state.opts.align);
                break;
            case "code":
                layoutCode(state, block, x, w);
                break;
            case "hr": {
                const space = base * 0.4;
                state.out.decorations.push({ kind: "hr", x, y: state.y + space, w, h: 1 });
                state.y += space * 2 + 1;
                break;
            }
            case "blockquote": {
                const inset = base;
                const top = state.y;
                layoutBlocks(state, block.blocks, x + inset, Math.max(w - inset, 1), depth + 1, gap);
                state.out.decorations.push({ kind: "quote-bar", x: x + inset * 0.25, y: top, w: Math.max(2, base * 0.1), h: state.y - top });
                break;
            }
            case "list":
                layoutList(state, block, x, w, depth, gap);
                break;
            case "table":
                layoutTable(state, block, x, w);
                break;
        }
    }

    // Wraps styled runs into lines of width w starting at (x, state.y).
    function layoutInlines(state, runs, x, w, px, forceBold, align) {
        const { ctx, opts, out } = state;
        const lineH = px * opts.lineHeight;
        let line = [];
        let lineW = 0;

        const commit = () => {
            // Trailing whitespace must not count towards the line's width or alignment.
            const last = line[line.length - 1];
            if (last && !last.code && /\s$/.test(last.text)) {
                last.text = last.text.replace(/\s+$/, "");
                ctx.font = last.font;
                last.w = ctx.measureText(last.text).width;
                lineW = last.x + last.w;
            }
            const shift = align === "center" ? (w - lineW) / 2 : align === "right" ? w - lineW : 0;
            const y = state.y;
            const placed = [];
            for (const piece of line) {
                const runX = x + shift + piece.x;
                const runY = y + (lineH - piece.px) / 2;
                placed.push({ x: runX, y: runY, text: piece.text, font: piece.font, px: piece.px, underline: !!piece.link, strike: piece.strike, code: piece.code, link: piece.link });
                if (piece.link) out.links.push({ x: runX, y, w: piece.w, h: lineH, href: piece.link });
                if (piece.code) out.decorations.push({ kind: "codespan", x: runX - piece.px * 0.12, y: y + lineH * 0.08, w: piece.w + piece.px * 0.24, h: lineH * 0.84 });
            }
            out.lines.push({ y, height: lineH, x: x + shift, width: lineW, runs: placed });
            state.y += lineH;
            line = [];
            lineW = 0;
        };

        for (const run of runs) {
            if (run.br) { commit(); continue; }
            const style = forceBold ? { ...run, bold: true } : run;
            const runPx = run.code ? px * CODE_SCALE : px;
            const font = fontFor(state, style, runPx);
            ctx.font = font;

            // Tokens keep their trailing spaces so a wrap can drop them at the break.
            const tokens = run.code ? [run.text] : run.text.split(/(?<=\s)(?=\S)/);
            for (let token of tokens) {
                if (!token) continue;
                let width = ctx.measureText(token).width;
                if (line.length && lineW + ctx.measureText(token.replace(/\s+$/, "")).width > w) {
                    commit();
                    token = token.replace(/^\s+/, "");
                    if (!token) continue;
                    width = ctx.measureText(token).width;
                }
                // A token wider than the line is split by character.
                while (width > w && token.length > 1) {
                    let cut = token.length - 1;
                    while (cut > 1 && ctx.measureText(token.slice(0, cut)).width > w) cut--;
                    const head = token.slice(0, cut);
                    line.push({ x: lineW, w: ctx.measureText(head).width, text: head, font, px: runPx, ...pick(style) });
                    lineW += ctx.measureText(head).width;
                    commit();
                    token = token.slice(cut);
                    width = ctx.measureText(token).width;
                }
                const last = line[line.length - 1];
                if (last && last.font === font && last.link === style.link && last.strike === style.strike && last.code === style.code) {
                    last.text += token;
                    last.w += width;
                } else {
                    line.push({ x: lineW, w: width, text: token, font, px: runPx, ...pick(style) });
                }
                lineW += width;
            }
        }
        if (line.length) commit();
        else if (!runs.length) state.y += lineH;
    }

    const pick = style => ({ link: style.link || null, strike: !!style.strike, code: !!style.code });

    function layoutCode(state, block, x, w) {
        const { ctx, opts, out } = state;
        const px = opts.fontSize * CODE_SCALE;
        const lineH = px * opts.lineHeight;
        const pad = opts.fontSize * 0.5;
        const font = fontFor(state, { code: true }, px);
        ctx.font = font;
        const innerW = Math.max(w - pad * 2, 1);
        const top = state.y;
        state.y += pad;

        const src = block.text.length ? block.text.split("\n") : [""];
        for (const raw of src) {
            let rest = raw;
            do {
                let piece = rest;
                if (ctx.measureText(piece).width > innerW) {
                    let cut = piece.length - 1;
                    while (cut > 1 && ctx.measureText(piece.slice(0, cut)).width > innerW) cut--;
                    piece = piece.slice(0, cut);
                }
                const width = ctx.measureText(piece).width;
                out.lines.push({ y: state.y, height: lineH, x: x + pad, width, runs: [{ x: x + pad, y: state.y + (lineH - px) / 2, text: piece, font, px, underline: false, strike: false, code: true, link: null }] });
                state.y += lineH;
                rest = rest.slice(piece.length);
            } while (rest.length);
        }

        state.y += pad;
        out.decorations.push({ kind: "codeblock", x, y: top, w, h: state.y - top, r: Math.min(8, opts.fontSize * 0.25) });
    }

    function layoutList(state, block, x, w, depth, gap) {
        const { ctx, opts, out } = state;
        const base = opts.fontSize;
        let indent = base * 1.5;
        // A wide number like "100." would otherwise sit left of the box.
        if (block.ordered) {
            ctx.font = fontFor(state, {}, base);
            indent = Math.max(indent, ctx.measureText(`${block.start + block.items.length - 1}.`).width + base * 0.5);
        }
        const innerX = x + indent;
        const innerW = Math.max(w - indent, 1);
        const itemGap = base * 0.2;
        const lineH = base * opts.lineHeight;

        for (let n = 0; n < block.items.length; n++) {
            if (n > 0) state.y += itemGap;
            const item = block.items[n];
            const top = state.y;

            if (item.checked !== null) {
                const size = base * 0.75;
                out.decorations.push({ kind: "checkbox", x: x + (indent - size) / 2, y: top + (lineH - size) / 2, w: size, h: size, checked: item.checked, r: Math.max(2, size * 0.18) });
            } else {
                const label = block.ordered ? `${block.start + n}.` : BULLETS[Math.min(depth, BULLETS.length - 1)];
                const font = fontFor(state, {}, base);
                ctx.font = font;
                const width = ctx.measureText(label).width;
                const markerX = block.ordered ? innerX - width - base * 0.35 : x + (indent - width) / 2;
                out.lines.push({ y: top, height: lineH, x: markerX, width, marker: true, runs: [{ x: markerX, y: top + (lineH - base) / 2, text: label, font, px: base, underline: false, strike: false, code: false, link: null }] });
            }

            if (item.blocks.length) layoutBlocks(state, item.blocks, innerX, innerW, depth + 1, gap * 0.6);
            else state.y += lineH;
        }
    }

    function layoutTable(state, block, x, w) {
        const { ctx, opts, out } = state;
        const base = opts.fontSize;
        const pad = base * 0.4;
        const cols = block.head.length;
        const lineH = base * opts.lineHeight;

        // Natural width of each column, then shrunk proportionally to fit the box.
        const natural = new Array(cols).fill(0);
        const measureRow = (cells, bold) => cells.forEach((runs, c) => {
            let width = 0;
            for (const run of runs) {
                if (run.br) continue;
                ctx.font = fontFor(state, bold ? { ...run, bold: true } : run, run.code ? base * CODE_SCALE : base);
                width += ctx.measureText(run.text).width;
            }
            natural[c] = Math.max(natural[c], width);
        });
        measureRow(block.head, true);
        for (const row of block.rows) measureRow(row, false);

        const minCol = base * 2;
        const available = Math.max(w - pad * 2 * cols, minCol * cols);
        const total = natural.reduce((a, b) => a + b, 0) || 1;
        const widths = natural.map(n => Math.max(minCol, total > available ? n / total * available : n));

        const layoutRow = (cells, bold) => {
            const top = state.y;
            let bottom = top;
            let cx = x;
            cells.forEach((runs, c) => {
                state.y = top + pad * 0.5;
                layoutInlines(state, runs, cx + pad, widths[c], base, bold, block.align[c]);
                bottom = Math.max(bottom, state.y);
                cx += widths[c] + pad * 2;
            });
            state.y = Math.max(bottom, top + lineH) + pad * 0.5;
            return cx - x;
        };

        const top = state.y;
        const tableW = layoutRow(block.head, true);
        out.decorations.push({ kind: "table-rule", x, y: state.y, w: tableW, h: 1.5 });
        for (const row of block.rows) {
            layoutRow(row, false);
            out.decorations.push({ kind: "table-rule", x, y: state.y, w: tableW, h: 1 });
        }
        out.decorations.push({ kind: "table-rule", x, y: top, w: tableW, h: 1 });
    }

    /* ================================================================== cache */

    const cache = new WeakMap();
    let generation = 0;

    // Parse is reused while the content string is the same object or value; layout is
    // reused while the geometry inputs are; colour is not an input at all.
    function layoutFor(obj, ctx, opts) {
        let entry = cache.get(obj);
        if (!entry) { entry = { parse: null, layout: null }; cache.set(obj, entry); }

        const content = obj.text.content || "";
        if (!entry.parse || entry.parse.content !== content) {
            entry.parse = { content, blocks: parse(content) };
            entry.layout = null;
        }

        const l = entry.layout;
        if (l && l.gen === generation && l.width === opts.width && l.fontSize === opts.fontSize &&
            l.fontCss === opts.fontCss && l.align === opts.align) return l.result;

        const result = layout(ctx, entry.parse.blocks, opts);
        entry.layout = { gen: generation, width: opts.width, fontSize: opts.fontSize, fontCss: opts.fontCss, align: opts.align, result };
        return result;
    }

    // Font arrival changes every measurement, so the renderer bumps this alongside its wrap cache.
    function invalidate() { generation++; }

    function linkAt(result, x, y) {
        const links = result.links;
        if (!links.length) return null;
        for (let i = links.length - 1; i >= 0; i--) {
            const l = links[i];
            if (x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) return l.href;
        }
        return null;
    }

    window.ZenEaselMarkdown = { parse, layout, layoutFor, invalidate, linkAt, MONO };
})();
