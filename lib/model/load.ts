import { readFileSync } from "node:fs";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import type { ArchitectureModel } from "./schema";
import { validateModel } from "./validate";

/** Where the model lives in the repository. */
export const MODEL_PATH = "architecture/soc.yaml";

export class ModelInvalidError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `${MODEL_PATH} failed validation (${issues.length} issue(s)):\n${issues
        .slice(0, 20)
        .map((issue) => `  ${issue}`)
        .join("\n")}\nRun \`python3 scripts/validate_model.py\` for the canonical report.`,
    );
  }
}

/**
 * Parses and validates the text of a model.
 *
 * Failure is loud on purpose: a model that does not satisfy the schema means
 * every downstream surface would render invented or missing data, which the
 * product principles forbid. scripts/validate_model.py gates this in CI; this
 * is the runtime backstop, and the gate for edits made in Atlas.
 */
export function parseModel(text: string): ArchitectureModel {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ModelInvalidError([error instanceof Error ? error.message.split("\n")[0] : "not valid YAML"]);
  }
  const result = validateModel(raw);
  if (!result.ok) throw new ModelInvalidError(result.issues);
  return result.model;
}

let cached: ArchitectureModel | null = null;

/** The model bundled with this deployment, parsed once per server process. */
export function loadModel(): ArchitectureModel {
  cached ??= parseModel(readFileSync(path.join(process.cwd(), MODEL_PATH), "utf8"));
  return cached;
}
