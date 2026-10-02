import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { ZodError } from "zod";
import { RoleSchema, ScenarioMetaSchema, ScriptSchema, type Role, type Scenario } from "./schema.js";

export class ScenarioLoadError extends Error {
  constructor(message: string) { super(message); this.name = "ScenarioLoadError"; }
}

async function readYaml(file: string): Promise<unknown> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch { throw new ScenarioLoadError(`missing file ${file}`); }
  try { return parse(text); }
  catch (err) { throw new ScenarioLoadError(`${file}: ${(err as Error).message}`); }
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
    const role = parseWith(RoleSchema, await readYaml(path.join(rolesDir, f)), `roles/${f}`);
    if (roles[role.id]) throw new ScenarioLoadError(`roles/${f}: role id '${role.id}' is already defined`);
    roles[role.id] = role;
  }
  const script = parseWith(ScriptSchema, await readYaml(path.join(dir, "script.yaml")), "script.yaml");
  return { meta, roles, script };
}
