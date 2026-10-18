import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "public", "legacy");

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(path.join(root, "site"), target, { recursive: true });
await cp(path.join(root, "docs"), path.join(target, "docs"), { recursive: true });
await cp(path.join(root, "architecture"), path.join(target, "architecture"), { recursive: true });

for (const filename of [
  "SoC_arch.png",
  "Systolic_array_ref.png",
  "Scalar_core_ref.png",
  "Vector_engine_ref.png",
  "core_ref.png",
  "SoC presentation.pdf",
  "reef_spec.pdf",
  "reef_spec2.pdf",
]) {
  const source = path.join(root, filename);
  if (existsSync(source)) await cp(source, path.join(target, filename));
}

const logo = path.join(root, "logo.png");
if (existsSync(logo)) {
  await mkdir(path.join(root, "public"), { recursive: true });
  await cp(logo, path.join(root, "public", "logo.png"));
}
