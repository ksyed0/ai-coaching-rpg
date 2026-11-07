/** Environment values that look like secrets (a key, token, password...). A leaf module: the read-only reports subpath imports it without the evaluator. */
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
export const secretValues = (env: NodeJS.ProcessEnv): string[] => Object.entries(env).filter(([k, v]) => SECRETISH.test(k) && typeof v === "string" && v.length >= 8).map(([, v]) => v as string);
