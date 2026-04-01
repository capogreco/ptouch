// Text-to-bitmap rendering via ImageMagick

export interface RenderedImage {
  width: number;
  height: number;
  /** pixels[y][x], true = black */
  pixels: boolean[][];
}

/**
 * Render text to a 1-bit bitmap using ImageMagick.
 *
 * @param text - The text to render
 * @param heightPx - Target image height in pixels
 * @param font - Font name (as known to fontconfig / ImageMagick)
 */
export async function renderText(
  text: string,
  heightPx: number,
  font: string,
): Promise<RenderedImage> {
  await assertImageMagick();

  // resolve font family name to a .ttf/.otf file path via fontconfig
  const fontPath = await resolveFontPath(font);

  const cmd = new Deno.Command("convert", {
    args: [
      "-background", "white",
      "-fill", "black",
      "-font", fontPath,
      "-pointsize", String(heightPx),
      `label:${text}`,
      "-trim", "+repage",
      "-threshold", "50%",
      "pbm:-",
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const result = await cmd.output();

  if (!result.success) {
    const err = new TextDecoder().decode(result.stderr);
    throw new Error(`ImageMagick failed: ${err}`);
  }

  return parsePBM(result.stdout);
}

/** List available system fonts, optionally filtered */
export async function listFonts(filter?: string): Promise<string[]> {
  const cmd = new Deno.Command("fc-list", {
    args: ["--format=%{family}\n"],
    stdout: "piped",
  });

  const result = await cmd.output();
  const fonts = new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .filter(Boolean)
    .map((f) => f.split(",")[0])
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();

  return filter
    ? fonts.filter((f) => f.toLowerCase().includes(filter.toLowerCase()))
    : fonts;
}

/** Resolve a font family name to its file path via fontconfig */
async function resolveFontPath(font: string): Promise<string> {
  // if it's already a file path, use it directly
  if (font.startsWith("/")) return font;

  const cmd = new Deno.Command("fc-match", {
    args: ["--format=%{file}", font],
    stdout: "piped",
    stderr: "null",
  });
  const result = await cmd.output();
  const path = new TextDecoder().decode(result.stdout).trim();

  if (!path) {
    throw new Error(`Font not found: ${font}`);
  }

  return path;
}

/** Check that ImageMagick is installed */
async function assertImageMagick(): Promise<void> {
  try {
    const cmd = new Deno.Command("convert", {
      args: ["-version"],
      stdout: "null",
      stderr: "null",
    });
    const result = await cmd.output();
    if (!result.success) throw new Error();
  } catch {
    throw new Error(
      "ImageMagick is required but not found.\n" +
        "Install it with: sudo apt install imagemagick",
    );
  }
}

// ===== PBM PARSING =====

function parsePBM(data: Uint8Array): RenderedImage {
  const text = new TextDecoder().decode(data);
  const lines = text.split("\n");

  let i = 0;
  const magic = lines[i++].trim();

  // skip comments
  while (i < lines.length && lines[i].startsWith("#")) i++;

  const [w, h] = lines[i++].trim().split(/\s+/).map(Number);

  if (magic === "P1") {
    const rest = lines.slice(i).join(" ").trim().split(/\s+/);
    const pixels: boolean[][] = [];
    let idx = 0;
    for (let y = 0; y < h; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < w; x++) {
        row.push(rest[idx++] === "1");
      }
      pixels.push(row);
    }
    return { width: w, height: h, pixels };
  }

  if (magic === "P4") {
    const headerEnd = findP4HeaderEnd(data);
    const bin = data.slice(headerEnd);
    const rowBytes = Math.ceil(w / 8);
    const pixels: boolean[][] = [];
    for (let y = 0; y < h; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < w; x++) {
        const byteIdx = y * rowBytes + Math.floor(x / 8);
        const bitIdx = 7 - (x % 8);
        row.push(((bin[byteIdx] >> bitIdx) & 1) === 1);
      }
      pixels.push(row);
    }
    return { width: w, height: h, pixels };
  }

  throw new Error(`Unsupported PBM format: ${magic}`);
}

function findP4HeaderEnd(data: Uint8Array): number {
  let i = 0;
  let newlines = 0;
  let inComment = false;

  while (i < data.length) {
    if (data[i] === 0x23) inComment = true;
    else if (data[i] === 0x0A) {
      if (!inComment) newlines++;
      inComment = false;
      if (newlines >= 2) return i + 1;
    }
    i++;
  }
  return i;
}
