// USB device discovery, status queries, and I/O for Brother P-touch printers

import type { PtouchModel } from "./models.ts";
import { findModel, MODELS } from "./models.ts";
import {
  buildStatusRequest,
  parseStatus,
  type PrinterStatus,
} from "./protocol.ts";

export interface PtouchDevice {
  /** The matched model (if known) */
  model: PtouchModel;
  /** Device file path, e.g. /dev/usb/lp0 */
  devicePath: string;
  /** USB ID string, e.g. "04f9:20af" */
  usbId: string;
}

/**
 * Discover connected Brother P-touch printers via lsusb.
 * Returns all recognised devices.
 */
export async function discover(): Promise<PtouchDevice[]> {
  const cmd = new Deno.Command("lsusb", { stdout: "piped", stderr: "null" });
  const result = await cmd.output();
  const output = new TextDecoder().decode(result.stdout);

  const devices: PtouchDevice[] = [];
  const knownIds = Object.keys(MODELS);

  for (const line of output.split("\n")) {
    // lsusb format: "Bus 003 Device 005: ID 04f9:20af Brother Industries, Ltd ..."
    const match = line.match(/ID\s+([0-9a-f]{4}:[0-9a-f]{4})/i);
    if (!match) continue;

    const usbId = match[1].toLowerCase();
    if (!knownIds.includes(usbId)) continue;

    const model = findModel(usbId)!;
    const devicePath = await findDevicePath(usbId);
    if (devicePath) {
      devices.push({ model, devicePath, usbId });
    }
  }

  return devices;
}

/**
 * Find the /dev/usb/lpN device path for a given USB ID.
 * Falls back to /dev/usb/lp0 if detection fails.
 */
async function findDevicePath(usbId: string): Promise<string | null> {
  // try to find via usb device listing
  try {
    const cmd = new Deno.Command("bash", {
      args: ["-c", `ls /dev/usb/lp* 2>/dev/null`],
      stdout: "piped",
      stderr: "null",
    });
    const result = await cmd.output();
    const paths = new TextDecoder()
      .decode(result.stdout)
      .trim()
      .split("\n")
      .filter(Boolean);

    // if only one printer device, use it
    if (paths.length === 1) return paths[0];

    // if multiple, try to match by reading device info
    // for now, return the first one
    if (paths.length > 0) return paths[0];
  } catch {
    // ignore
  }

  return null;
}

/** Query the printer status */
export async function queryStatus(devicePath: string): Promise<PrinterStatus> {
  const dev = await Deno.open(devicePath, { read: true, write: true });

  try {
    await dev.write(buildStatusRequest());

    const buf = new Uint8Array(32);
    let offset = 0;
    const deadline = Date.now() + 5000;

    while (offset < 32) {
      if (Date.now() > deadline) {
        throw new Error("timeout waiting for printer status response");
      }
      const n = await dev.read(buf.subarray(offset));
      if (n === null || n === 0) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      offset += n;
    }

    return parseStatus(buf);
  } finally {
    dev.close();
  }
}

/** Send raw print data to the printer */
export async function sendData(
  devicePath: string,
  data: Uint8Array,
): Promise<void> {
  const file = await Deno.open(devicePath, { write: true });
  try {
    await file.write(data);
  } finally {
    file.close();
  }
}

/** Check if we have write permission to the device */
export async function checkPermissions(devicePath: string): Promise<boolean> {
  try {
    const file = await Deno.open(devicePath, { write: true });
    file.close();
    return true;
  } catch {
    return false;
  }
}
