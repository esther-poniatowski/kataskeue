import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("publishes representable constraints and names executable-only constraints", async () => {
  const schema = JSON.parse(
    await readFile("schemas/obsidian-plugins.schema.json", "utf8"),
  ) as unknown;
  const repositoryPatterns = collectRepositoryPatterns(schema);
  assert.equal(repositoryPatterns.length, 2);
  for (const pattern of repositoryPatterns) {
    const expression = new RegExp(pattern);
    assert.equal(expression.test("https://github.com/example/plugin"), true);
    assert.equal(expression.test("http://github.com/example/plugin"), false);
  }
  const text = JSON.stringify(schema);
  assert.match(text, /unique-plugin-identifiers/);
  assert.match(text, /identifier-order/);
});

test("requires the identifier of the record in _schema", async () => {
  const schema = JSON.parse(
    await readFile("schemas/obsidian-plugins.schema.json", "utf8"),
  ) as {
    properties: Record<string, { const?: string }>;
    required: string[];
  };
  assert.equal(Object.keys(schema.properties)[0], "_schema");
  assert.equal(
    schema.properties._schema?.const,
    "kataskeue:obsidian-plugins@1",
  );
  assert.ok(schema.required.includes("_schema"));
  assert.equal("format_version" in schema.properties, false);
});

function collectRepositoryPatterns(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectRepositoryPatterns);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const properties = record.properties;
  let own: unknown = null;
  if (typeof properties === "object" && properties !== null) {
    const repository = (properties as Record<string, unknown>).repository;
    if (typeof repository === "object" && repository !== null) {
      own = (repository as Record<string, unknown>).pattern;
    }
  }
  return [
    ...(typeof own === "string" ? [own] : []),
    ...Object.values(record).flatMap(collectRepositoryPatterns),
  ];
}
