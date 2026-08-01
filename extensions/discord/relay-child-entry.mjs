#!/usr/bin/env node

import { createJiti } from "jiti";

const directory = process.argv[2];
if (!directory) throw new Error("Discord relay child requires its private data directory");

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { runDefaultRelayChild } = await jiti.import("./relay-child.ts");
await runDefaultRelayChild(directory);
