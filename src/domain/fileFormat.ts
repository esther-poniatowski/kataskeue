import { FileFormatError } from "../errors.js";

/** Key replaced by `_schema`, reported by name so that a file can be migrated. */
const RETIRED_KEY = "format_version";

/**
 * Reject a file that does not declare the identifier `expected` in `_schema`.
 *
 * The whole value is compared, and the message names the expected declaration. `label` names
 * the file in the message.
 */
export function requireFileFormat(
  content: unknown,
  expected: string,
  label: string,
): void {
  const fields =
    typeof content === "object" && content !== null
      ? (content as Record<string, unknown>)
      : {};
  const declaration = `_schema: ${expected}`;
  if (RETIRED_KEY in fields) {
    throw new FileFormatError(
      `${label}: the key ${RETIRED_KEY} is retired; write ${declaration} as the first key in its place`,
    );
  }
  if (!("_schema" in fields)) {
    throw new FileFormatError(
      `${label}: the key _schema is absent; write ${declaration} as the first key`,
    );
  }
  if (fields._schema !== expected) {
    throw new FileFormatError(
      `${label}: _schema holds ${JSON.stringify(fields._schema)}; write ${declaration}`,
    );
  }
}
