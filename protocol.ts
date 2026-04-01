// Brother P-touch raster command protocol
// Reference: Brother Raster Command Reference for PT-E550W/P750W/P710BT

import type { PtouchModel } from "./models.ts";
import { tapeLeftMargin, tapePixels } from "./models.ts";

export interface PrintOptions {
  /** Tape width in mm (from printer status) */
  tapeWidthMm: number;
  /** Enable auto-cut after printing */
  autoCut?: boolean;
  /** Mirror print (for iron-on tape) */
  mirror?: boolean;
  /** Feed margin in dots */
  margin?: number;
  /** Right-side padding in dots before cut */
  padding?: number;
}

const DEFAULTS: Required<Omit<PrintOptions, "tapeWidthMm">> = {
  autoCut: true,
  mirror: false,
  margin: 14,
  padding: 40,
};

/**
 * Build complete raster print data from a 1-bit pixel grid.
 *
 * The pixel grid is oriented as the label reads:
 *   pixels[y][x] where y = across tape width, x = along tape length.
 *
 * Each column (x) becomes one raster line sent to the printer.
 */
export function buildPrintData(
  model: PtouchModel,
  pixels: boolean[][],
  opts: PrintOptions,
): Uint8Array {
  const o = { ...DEFAULTS, ...opts };
  const tapePx = tapePixels(model, o.tapeWidthMm);
  const leftMargin = tapeLeftMargin(model, o.tapeWidthMm);

  if (tapePx === undefined || leftMargin === undefined) {
    throw new Error(
      `Unsupported tape width ${o.tapeWidthMm}mm for ${model.name}`,
    );
  }

  const textHeight = pixels.length;
  const textWidth = pixels[0]?.length ?? 0;
  const { rasterBytes, headPins } = model;

  // Centre text vertically within the printable area, then offset
  // by the left margin to position it on the correct physical pins.
  //
  // Pin numbering (from Brother Raster Command Reference):
  //   Pin 0 is at the last-byte end ("left margin" side).
  //   The first byte of raster data corresponds to the highest pins
  //   ("right margin" side).
  //
  // For 9mm tape on a 128-pin head:
  //   left margin = 39 pins (pin 0-38), print area = 50 pins (pin 39-88),
  //   right margin = 39 pins (pin 89-127).
  const yOffset = leftMargin + Math.floor((tapePx - textHeight) / 2);

  const scaledPadding = Math.round(o.padding * (o.tapeWidthMm / 24));
  const numLines = textWidth + scaledPadding;
  const parts: Uint8Array[] = [];

  // invalidate
  parts.push(new Uint8Array(100));

  // initialise
  parts.push(cmd(0x1B, 0x40));

  // raster mode
  parts.push(cmd(0x1B, 0x69, 0x61, 0x01));

  // media info
  parts.push(
    cmd(
      0x1B, 0x69, 0x7A,
      0x86,                             // valid flags
      0x01,                             // media type: laminated TZe
      o.tapeWidthMm,                    // width mm
      0x00,                             // length mm (0 = continuous)
      numLines & 0xFF,                  // raster lines (32-bit LE)
      (numLines >> 8) & 0xFF,
      (numLines >> 16) & 0xFF,
      (numLines >> 24) & 0xFF,
      0x00,                             // page
      0x00,
    ),
  );

  // auto-cut mode
  parts.push(cmd(0x1B, 0x69, 0x4B, o.autoCut ? 0x08 : 0x00));

  // mirror mode
  parts.push(cmd(0x1B, 0x69, 0x4D, o.mirror ? 0x40 : 0x00));

  // feed margin
  parts.push(cmd(0x1B, 0x69, 0x64, o.margin & 0xFF, (o.margin >> 8) & 0xFF));

  // no compression
  parts.push(cmd(0x4D, 0x00));

  // raster data — each column of the rendered text becomes one raster line
  for (let x = 0; x < numLines; x++) {
    const line = new Uint8Array(rasterBytes);

    for (let y = 0; y < textHeight; y++) {
      if (x < textWidth && pixels[y][x]) {
        const pin = yOffset + (textHeight - 1 - y);
        // Brother raster byte order: byte 0 = highest pins, byte 15 = pin 0.
        // Within each byte, MSB = higher pin number, LSB = lower pin number.
        // So pin N maps to:
        //   byteIdx = (maxPin - N) / 8  (byte 0 has pins 127..120)
        //   bitIdx  = N % 8             (bit 0 = lowest pin in that byte)
        const byteIdx = Math.floor((headPins - 1 - pin) / 8);
        const bitIdx = pin % 8;
        if (byteIdx >= 0 && byteIdx < rasterBytes) {
          line[byteIdx] |= 1 << bitIdx;
        }
      }
    }

    parts.push(cmd(0x47, rasterBytes & 0xFF, (rasterBytes >> 8) & 0xFF));
    parts.push(line);
  }

  // print and feed
  parts.push(cmd(0x1A));

  return concat(parts);
}

/** Build a status request command sequence */
export function buildStatusRequest(): Uint8Array {
  return concat([
    new Uint8Array(100),        // invalidate
    cmd(0x1B, 0x40),            // initialise
    cmd(0x1B, 0x69, 0x53),     // status request
  ]);
}

export interface PrinterStatus {
  error1: number;
  error2: number;
  tapeWidthMm: number;
  mediaType: number;
}

/** Parse a 32-byte status response */
export function parseStatus(buf: Uint8Array): PrinterStatus {
  return {
    error1: buf[8],
    error2: buf[9],
    tapeWidthMm: buf[10],
    mediaType: buf[11],
  };
}

/** Check if status indicates any error */
export function hasError(status: PrinterStatus): boolean {
  return status.error1 !== 0 || status.error2 !== 0;
}

// helpers

function cmd(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    result.set(p, off);
    off += p.length;
  }
  return result;
}
