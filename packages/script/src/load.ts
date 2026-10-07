import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
import { ZodError } from "zod";
import { RoleSchema, ScenarioMetaSchema, ScriptSchema, type Role, type Scenario } from "./schema.js";

export class ScenarioLoadError extends Error {
  constructor(message: string) { super(message); this.name = "ScenarioLoadError"; }
}

async function readYaml(file: string, check?: (doc: ReturnType<typeof parseDocument>) => void): Promise<unknown> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch { throw new ScenarioLoadError(`missing file ${file}`); }
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(text);
    if (doc.errors.length > 0) throw doc.errors[0];
  } catch (err) { throw new ScenarioLoadError(`${file}: ${(err as Error).message}`); }
  check?.(doc);
  try { return doc.toJS(); }
  catch (err) { throw new ScenarioLoadError(`${file}: ${(err as Error).message}`); }
}

/**
 * US-0034: two `earned_when` keys that name the same fact once read as JavaScript (`1` and `"1"`, `1.0`, `0x1`) are different YAML keys, so the
 * parser accepts them and the second silently replaces the first. Refuse them while the YAML keys are still visible.
 */
function refuseDuplicateEarnedWhen(label: string): (doc: ReturnType<typeof parseDocument>) => void {
  return (doc) => {
    const root = doc.contents;
    if (!isMap(root)) return;
    const node = root.get("earned_when", true);
    if (!isMap(node)) return;
    const seen = new Set<string>();
    for (const pair of node.items) {
      const k = String(isScalar(pair.key) ? pair.key.value : pair.key);
      if (seen.has(k)) throw new ScenarioLoadError(`${label}: earned_when names hidden fact ${k} more than once`);
      seen.add(k);
    }
  };
}

function parseWith<T>(schema: { parse(v: unknown): T }, value: unknown, label: string): T {
  try { return schema.parse(value); }
  catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      throw new ScenarioLoadError(`${label}: ${first.path.join(".") || "(root)"} ${first.message}`);
    }
    throw err;
  }
}

export async function loadScenario(dir: string): Promise<Scenario> {
  const meta = parseWith(ScenarioMetaSchema, await readYaml(path.join(dir, "scenario.yaml")), "scenario.yaml");
  const rolesDir = path.join(dir, "roles");
  try { if (!(await stat(rolesDir)).isDirectory()) throw new Error(); }
  catch { throw new ScenarioLoadError(`${dir}: roles/ directory is missing`); }
  const files = (await readdir(rolesDir)).filter((f) => f.endsWith(".yaml")).sort();
  if (files.length === 0) throw new ScenarioLoadError(`${dir}: roles/ directory is empty`);
  const roles: Record<string, Role> = {};
  for (const f of files) {
    const role = parseWith(RoleSchema, await readYaml(path.join(rolesDir, f), refuseDuplicateEarnedWhen(`roles/${f}`)), `roles/${f}`);
    if (roles[role.id]) throw new ScenarioLoadError(`roles/${f}: role id '${role.id}' is already defined`);
    roles[role.id] = role;
  }
  const script = parseWith(ScriptSchema, await readYaml(path.join(dir, "script.yaml")), "script.yaml");
  return { meta, roles, script };
}
