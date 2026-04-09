#!/usr/bin/env -S deno run --allow-all

// ptouch - Brother P-touch label printer CLI

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import {
  checkPermissions,
  discover,
  queryStatus,
  sendData,
} from "./device.ts";
import { supportedModels, tapePixels, TAPE_PIXELS_128 } from "./models.ts";
import { pickFont } from "./picker.ts";
import { buildPrintData, hasError } from "./protocol.ts";
import { listFonts, renderText } from "./render.ts";
import { join } from "jsr:@std/path@1/join";

const VERSION = "0.1.0";

function stateFilePath(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  return join(home, ".config", "ptouch", "state.json");
}

function loadLastFont(): string | undefined {
  try {
    const data = JSON.parse(Deno.readTextFileSync(stateFilePath()));
    return data.lastFont;
  } catch {
    return undefined;
  }
}

function saveLastFont(font: string): void {
  try {
    const path = stateFilePath();
    Deno.mkdirSync(join(path, ".."), { recursive: true });
    Deno.writeTextFileSync(path, JSON.stringify({ lastFont: font }) + "\n");
  } catch {
    // non-critical, ignore
  }
}

const HELP = `
  ptouch - Brother P-touch label printer CLI

  USAGE
    ptouch [options] "text to print"

  OPTIONS
    -f, --font <name>     Font name (default: DejaVu-Sans)
    -t, --tape <mm>       Tape width in mm (auto-detected if omitted)
    -d, --device <path>   Device path (auto-detected if omitted)
    -p, --preview         Preview label in terminal without printing
    -h, --help            Show this help
    -v, --version         Show version

  COMMANDS
    ptouch status         Show printer status
    ptouch fonts [query]  List available fonts
    ptouch pick [text]    Interactive font picker with preview
    ptouch models         List supported printer models

  EXAMPLES
    ptouch "Hello World"
    ptouch -f "Ubuntu-Bold" "Kitchen"
    ptouch -p "preview this"
    ptouch status
    ptouch fonts mono
    ptouch pick "Kitchen"
`;

// ===== ANSI HELPERS =====

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function die(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  Deno.exit(1);
}

// ===== PREVIEW =====

function preview(
  pixels: boolean[][],
  tapePx: number,
  textHeight: number,
) {
  const yOffset = Math.floor((tapePx - textHeight) / 2);
  const width = pixels[0]?.length ?? 0;
  const yStart = Math.max(0, yOffset - 1);
  const yEnd = Math.min(tapePx, yOffset + textHeight + 1);

  for (let y = yStart; y < yEnd; y++) {
    let row = "";
    for (let x = 0; x < width; x++) {
      const py = y - yOffset;
      if (py >= 0 && py < textHeight && pixels[py][x]) {
        row += "\u2588";
      } else {
        row += " ";
      }
    }
    console.log(row);
  }
}

// ===== COMMANDS =====

async function cmdStatus(devicePath?: string) {
  const dev = await resolvePrinter(devicePath);
  const status = await queryStatus(dev.devicePath);

  console.log(c.bold(`  ${dev.model.name}`));
  console.log(`  Device:  ${c.cyan(dev.devicePath)}`);
  console.log(`  Tape:    ${status.tapeWidthMm}mm`);
  console.log(
    `  Media:   ${status.mediaType === 0x01 ? "TZe laminated" : `0x${status.mediaType.toString(16)}`}`,
  );
  console.log(
    `  Status:  ${hasError(status) ? c.red(`error 0x${status.error1.toString(16)} 0x${status.error2.toString(16)}`) : c.green("ready")}`,
  );
}

async function cmdFonts(filter?: string) {
  const fonts = await listFonts(filter);
  for (const f of fonts) console.log(`  ${f}`);
  console.log(
    c.dim(`\n  ${fonts.length} font${fonts.length !== 1 ? "s" : ""}${filter ? ` matching "${filter}"` : ""}`),
  );
}

async function cmdPick(
  previewText: string | undefined,
  opts: { tape: number; device?: string },
) {
  const fonts = await listFonts();

  // resolve tape pixels for preview sizing
  let tapePx = 128;
  if (opts.tape > 0) {
    tapePx = TAPE_PIXELS_128[opts.tape] ?? 128;
  } else {
    try {
      const dev = await resolvePrinter(opts.device);
      const status = await queryStatus(dev.devicePath);
      if (status.tapeWidthMm > 0) {
        tapePx = tapePixels(dev.model, status.tapeWidthMm) ?? 128;
      }
    } catch {
      // no printer available, use default
    }
  }

  const text = previewText ?? "Hello";
  const lastFont = loadLastFont();
  const result = await pickFont(fonts, text, tapePx, lastFont);

  if (result.cancelled) {
    console.log(c.dim("  cancelled"));
    return;
  }

  console.log(`\n  selected: ${c.cyan(result.font)}`);
  saveLastFont(result.font);

  // prompt to print
  const answer = prompt(c.bold("  print this label? (Y/n)"));
  if (answer === null || answer.toLowerCase() === "n") {
    console.log(c.dim(`  use with: ptouch -f "${result.font}" "${text}"`));
  } else {
    await cmdPrint(text, {
      font: result.font,
      tape: opts.tape,
      device: opts.device,
      preview: false,
    });
  }
}

function cmdModels() {
  const models = supportedModels();
  console.log(c.bold("\n  Supported models:\n"));
  for (const m of models) {
    const conn = m.connections.join(", ");
    const tapes = m.tapeWidths.join("/") + "mm";
    console.log(`  ${c.cyan(m.name.padEnd(14))} ${tapes.padEnd(24)} ${c.dim(conn)}`);
  }
  console.log();
}

async function cmdPrint(
  text: string,
  opts: { font: string; tape: number; device?: string; preview: boolean },
) {
  const font = opts.font;
  const dryRun = opts.preview;

  // resolve printer (skip if preview-only with tape specified)
  let model;
  let devicePath: string | undefined;
  let tapeWidthMm = opts.tape;

  if (!dryRun || tapeWidthMm === 0) {
    const dev = await resolvePrinter(opts.device);
    model = dev.model;
    devicePath = dev.devicePath;

    if (tapeWidthMm === 0) {
      const status = await queryStatus(devicePath);
      if (hasError(status)) {
        die(
          `printer error: 0x${status.error1.toString(16)} 0x${status.error2.toString(16)}`,
        );
      }
      tapeWidthMm = status.tapeWidthMm;
      console.log(c.dim(`  detected ${tapeWidthMm}mm tape`));
    }
  }

  // for preview without printer, use a default model config
  if (!model) {
    model = { headPins: 128, rasterBytes: 16, name: "preview", maxTapeMm: 24 } as
      import("./models.ts").PtouchModel;
  }

  if (tapeWidthMm === 0) tapeWidthMm = 24;

  const tapePx = tapePixels(model, tapeWidthMm);
  if (!tapePx) {
    die(`unsupported tape width: ${tapeWidthMm}mm`);
  }

  const renderHeight = Math.floor(tapePx * 0.9);
  const { pixels, width, height } = await renderText(text, renderHeight, font);

  console.log(
    c.dim(`  "${text}" ${c.cyan(`${width}x${height}px`)} font:${font} tape:${tapeWidthMm}mm`),
  );

  preview(pixels, tapePx, height);

  if (dryRun) {
    console.log(c.dim("\n  preview only"));
    return;
  }

  const data = buildPrintData(model, pixels, { tapeWidthMm });
  await sendData(devicePath!, data);

  console.log(c.green(`\n  printed ${data.length} bytes`));
}

// ===== HELPERS =====

async function resolvePrinter(devicePath?: string) {
  if (devicePath) {
    const ok = await checkPermissions(devicePath);
    if (!ok) {
      die(
        `cannot write to ${devicePath}\n` +
          `  add yourself to the lp group: sudo usermod -aG lp $USER`,
      );
    }
    const devices = await discover();
    const dev = devices.find((d) => d.devicePath === devicePath);
    if (!dev) die(`no recognised printer at ${devicePath}`);
    return dev;
  }

  const devices = await discover();
  if (devices.length === 0) {
    die(
      "no Brother P-touch printer found\n" +
        "  is it connected via USB and powered on?",
    );
  }

  const dev = devices[0];
  const ok = await checkPermissions(dev.devicePath);
  if (!ok) {
    die(
      `cannot write to ${dev.devicePath}\n` +
        `  add yourself to the lp group: sudo usermod -aG lp $USER`,
    );
  }

  return dev;
}

// ===== MAIN =====

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["font", "tape", "device"],
    boolean: ["preview", "help", "version"],
    alias: {
      f: "font",
      t: "tape",
      d: "device",
      p: "preview",
      h: "help",
      v: "version",
    },
    default: {
      tape: "0",
    },
  });

  if (args.version) {
    console.log(`ptouch ${VERSION}`);
    Deno.exit(0);
  }

  if (args.help) {
    console.log(HELP);
    Deno.exit(0);
  }

  const positional = args._;
  const command = positional[0]?.toString() ?? "";

  switch (command) {
    case "status":
      await cmdStatus(args.device);
      break;

    case "fonts": {
      const filter = positional[1]?.toString();
      await cmdFonts(filter);
      break;
    }

    case "models":
      cmdModels();
      break;

    case "pick": {
      const previewText = positional[1]?.toString();
      await cmdPick(previewText, {
        tape: parseInt(args.tape as string),
        device: args.device as string | undefined,
      });
      break;
    }

    case "":
      console.log(HELP);
      Deno.exit(1);
      break;

    default:
      // no -f flag: go through font picker first
      if (!args.font) {
        await cmdPick(command, {
          tape: parseInt(args.tape as string),
          device: args.device as string | undefined,
        });
      } else {
        await cmdPrint(command, {
          font: args.font as string,
          tape: parseInt(args.tape as string),
          device: args.device as string | undefined,
          preview: args.preview as boolean,
        });
      }
  }
}
