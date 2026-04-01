// ptouch - Brother P-touch label printer library for Deno
//
// Library API for programmatic use.
// For CLI usage, see cli.ts.

export type { PtouchModel } from "./models.ts";
export { findModel, supportedModels, tapePixels, MODELS } from "./models.ts";

export type { PrintOptions, PrinterStatus } from "./protocol.ts";
export { buildPrintData, hasError } from "./protocol.ts";

export type { RenderedImage } from "./render.ts";
export { renderText, listFonts } from "./render.ts";

export type { PtouchDevice } from "./device.ts";
export {
  checkPermissions,
  discover,
  queryStatus,
  sendData,
} from "./device.ts";

import { discover, queryStatus, sendData } from "./device.ts";
import { tapePixels } from "./models.ts";
import { buildPrintData, hasError } from "./protocol.ts";
import { renderText } from "./render.ts";

/** High-level: print a text label to the first available printer */
export async function printLabel(
  text: string,
  options?: {
    font?: string;
    devicePath?: string;
    tapeWidthMm?: number;
  },
): Promise<{ devicePath: string; tapeWidthMm: number; bytesWritten: number }> {
  const font = options?.font ?? "DejaVu-Sans";

  // find printer
  let devicePath = options?.devicePath;
  let model;

  if (devicePath) {
    // use provided path, discover model
    const devices = await discover();
    const dev = devices.find((d) => d.devicePath === devicePath);
    if (!dev) throw new Error(`No recognised printer at ${devicePath}`);
    model = dev.model;
  } else {
    const devices = await discover();
    if (devices.length === 0) {
      throw new Error("No Brother P-touch printer found. Is it connected via USB?");
    }
    devicePath = devices[0].devicePath;
    model = devices[0].model;
  }

  // query status for tape width
  const status = await queryStatus(devicePath);
  if (hasError(status)) {
    throw new Error(
      `Printer error: 0x${status.error1.toString(16)} 0x${status.error2.toString(16)}`,
    );
  }

  const tapeWidthMm = options?.tapeWidthMm ?? status.tapeWidthMm;
  const tapePx = tapePixels(model, tapeWidthMm);
  if (!tapePx) {
    throw new Error(`Unsupported tape width: ${tapeWidthMm}mm`);
  }

  // render and print
  const renderHeight = Math.floor(tapePx * 0.9);
  const { pixels } = await renderText(text, renderHeight, font);
  const data = buildPrintData(model, pixels, { tapeWidthMm });

  await sendData(devicePath, data);

  return { devicePath, tapeWidthMm, bytesWritten: data.length };
}
