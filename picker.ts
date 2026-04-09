// Interactive font picker with live preview

import { renderText } from "./render.ts";

const ESC = "\x1b";
const CSI = `${ESC}[`;

const ansi = {
  clearScreen: `${CSI}2J${CSI}H`,
  clearLine: `${CSI}2K`,
  moveTo: (row: number, col: number) => `${CSI}${row};${col}H`,
  moveUp: (n: number) => `${CSI}${n}A`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  bold: (s: string) => `${CSI}1m${s}${CSI}0m`,
  dim: (s: string) => `${CSI}2m${s}${CSI}0m`,
  cyan: (s: string) => `${CSI}36m${s}${CSI}0m`,
  yellow: (s: string) => `${CSI}33m${s}${CSI}0m`,
  inverse: (s: string) => `${CSI}7m${s}${CSI}0m`,
};

interface PickerResult {
  font: string;
  cancelled: boolean;
}

export async function pickFont(
  fonts: string[],
  previewText: string,
  tapePx: number,
  initialFont?: string,
): Promise<PickerResult> {
  const encoder = new TextEncoder();
  const write = (s: string) => Deno.stdout.writeSync(encoder.encode(s));

  // terminal size
  const { columns = 80, rows: termRows = 24 } = Deno.consoleSize();

  let query = "";
  const initialIndex = initialFont ? fonts.indexOf(initialFont) : -1;
  let cursor = initialIndex >= 0 ? initialIndex : 0;
  let scroll = 0;
  let filtered = fonts;
  let previewLines: string[] = [];
  let previewDirty = true;

  const PREVIEW_HEIGHT = Math.min(Math.floor(tapePx * 0.3), 12);
  const HEADER_LINES = 3; // search bar + blank + "fonts:" label
  const FOOTER_LINES = 2; // blank + hint
  const PREVIEW_SECTION = PREVIEW_HEIGHT + 2; // preview + blank + label
  const LIST_HEIGHT = termRows - HEADER_LINES - FOOTER_LINES - PREVIEW_SECTION;

  function filter() {
    const q = query.toLowerCase();
    filtered = q
      ? fonts.filter((f) => f.toLowerCase().includes(q))
      : fonts;
    cursor = 0;
    scroll = 0;
    previewDirty = true;
  }

  async function updatePreview() {
    if (!previewDirty || filtered.length === 0) return;
    previewDirty = false;
    try {
      const font = filtered[cursor];
      const { pixels, height } = await renderText(
        previewText || font,
        PREVIEW_HEIGHT,
        font,
      );
      previewLines = [];
      for (let y = 0; y < height; y++) {
        let row = "";
        for (let x = 0; x < Math.min(pixels[y].length, columns - 4); x++) {
          row += pixels[y][x] ? "\u2588" : " ";
        }
        previewLines.push(row);
      }
    } catch {
      previewLines = ["  (preview unavailable)"];
    }
  }

  function draw() {
    write(ansi.clearScreen);

    // search bar
    write(
      `  ${ansi.bold("font:")} ${query}${ansi.dim("_")}` +
        `${ansi.dim(`  (${filtered.length}/${fonts.length})`)}\n\n`,
    );

    // font list
    const visible = Math.max(1, LIST_HEIGHT);
    if (cursor < scroll) scroll = cursor;
    if (cursor >= scroll + visible) scroll = cursor - visible + 1;

    for (let i = 0; i < visible; i++) {
      const idx = scroll + i;
      if (idx >= filtered.length) {
        write("\n");
        continue;
      }
      const name = filtered[idx];
      if (idx === cursor) {
        write(`  ${ansi.inverse(` ${name} `)}\n`);
      } else {
        write(`   ${name}\n`);
      }
    }

    // preview
    write(`\n  ${ansi.dim("preview:")}\n`);
    for (const line of previewLines) {
      write(`  ${line}\n`);
    }

    // footer
    write(
      `\n  ${ansi.dim("type to filter | \u2191\u2193 navigate | enter select | esc cancel")}`,
    );
  }

  // enter raw mode
  Deno.stdin.setRaw(true);
  write(ansi.hideCursor);

  try {
    filter();
    if (initialIndex >= 0) {
      cursor = initialIndex;
      previewDirty = true;
    }
    await updatePreview();
    draw();

    const buf = new Uint8Array(16);

    while (true) {
      const n = Deno.stdin.readSync(buf);
      if (n === null || n === 0) continue;

      const bytes = buf.slice(0, n);

      // escape sequences
      if (bytes[0] === 0x1B && bytes[1] === 0x5B) {
        // arrow keys
        if (bytes[2] === 0x41) {
          // up
          if (cursor > 0) {
            cursor--;
            previewDirty = true;
          }
        } else if (bytes[2] === 0x42) {
          // down
          if (cursor < filtered.length - 1) {
            cursor++;
            previewDirty = true;
          }
        }
      } else if (bytes[0] === 0x1B) {
        // bare escape = cancel
        return { font: "", cancelled: true };
      } else if (bytes[0] === 0x0D || bytes[0] === 0x0A) {
        // enter
        if (filtered.length > 0) {
          return { font: filtered[cursor], cancelled: false };
        }
      } else if (bytes[0] === 0x7F || bytes[0] === 0x08) {
        // backspace
        if (query.length > 0) {
          query = query.slice(0, -1);
          filter();
        }
      } else if (bytes[0] === 0x03) {
        // ctrl-c
        return { font: "", cancelled: true };
      } else if (bytes[0] >= 0x20 && bytes[0] < 0x7F) {
        // printable char
        query += String.fromCharCode(bytes[0]);
        filter();
      }

      await updatePreview();
      draw();
    }
  } finally {
    Deno.stdin.setRaw(false);
    write(ansi.showCursor);
    write("\n");
  }
}
