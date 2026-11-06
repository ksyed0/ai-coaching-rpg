import { isFileSafeId } from "@acr/events";
import {
  ReviewBusyError,
  ReviewCorruptError,
  ReviewIllegalError,
  ReviewRefusedError,
  ReviewUsageError,
} from "../review/errors.js";
import type { ModResult } from "./types.js";

/**
 * Runs a moderation call and maps what it throws to a closed code, in this order: busy (a held lock; it extends the refusal, so it
 * is checked first), invalid (usage), unavailable (damage, an illegal fold, any other error such as I/O), the refusal's own code,
 * else refused. No message, path or id is carried, except subject ids in `detail`. For the control service; the CLI never uses it.
 */
export async function toModResult<T>(
  fn: () => Promise<T>,
): Promise<ModResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof ReviewBusyError) return { ok: false, code: "busy" };
    if (e instanceof ReviewUsageError) return { ok: false, code: "invalid" };
    if (e instanceof ReviewCorruptError || e instanceof ReviewIllegalError)
      return { ok: false, code: "unavailable" };
    if (e instanceof ReviewRefusedError) {
      if (e.code === undefined) return { ok: false, code: "refused" };
      const detail = (e.detail ?? []).filter(
        (d) => typeof d === "string" && isFileSafeId(d),
      );
      return {
        ok: false,
        code: e.code,
        ...(detail.length ? { detail } : {}),
      };
    }
    return { ok: false, code: "unavailable" };
  }
}
