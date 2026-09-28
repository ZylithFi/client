#!/usr/bin/env node

import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export function oversizedBundles(directory, maximumBytes) {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".js"))
    .map((file) => ({ file, bytes: statSync(resolve(directory, file)).size }))
    .filter(({ bytes }) => bytes > maximumBytes)
    .sort((left, right) => left.file.localeCompare(right.file));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = resolve(process.argv[2] ?? "dist/assets");
  const maximumBytes = Number(process.argv[3] ?? 700 * 1024);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("bundle budget must be a positive integer");
  }
  const oversized = oversizedBundles(directory, maximumBytes);
  if (oversized.length > 0) {
    for (const { file, bytes } of oversized) console.error(`${file} ${bytes}`);
    process.exit(1);
  }
}
