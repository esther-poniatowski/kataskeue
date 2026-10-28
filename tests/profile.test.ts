import assert from "node:assert/strict";
import test from "node:test";

import { parseLocalOverrides, parseProfile } from "../src/domain/profile.js";
import { ProfileError } from "../src/errors.js";

const digest = "a".repeat(64);

test("parses a canonical profile", () => {
  const profile = parseProfile({
    format_version: 1,
    runtime: {
      minimum_obsidian: "1.0.0",
      checked_obsidian: "1.14.5",
      checked_installer: "1.14.5",
    },
    plugins: [
      {
        id: "sample-plugin",
        repository: "https://github.com/example/sample-plugin",
        requirement: "required",
        enabled: true,
        bundle: { kind: "release", tag: "1.0.0" },
        files: { "manifest.json": digest, "main.js": digest },
        settings: { policy: "machine-local" },
      },
    ],
  });
  assert.equal(profile.plugins[0]?.id, "sample-plugin");
});

test("rejects an enabled optional plugin", () => {
  assert.throws(
    () =>
      parseProfile({
        format_version: 1,
        runtime: {
          minimum_obsidian: "1.0.0",
          checked_obsidian: "1.14.5",
          checked_installer: "1.14.5",
        },
        plugins: [
          {
            id: "sample-plugin",
            repository: "https://github.com/example/sample-plugin",
            requirement: "optional",
            enabled: true,
            bundle: { kind: "release", tag: "1.0.0" },
            files: { "manifest.json": digest, "main.js": digest },
            settings: { policy: "machine-local" },
          },
        ],
      }),
    ProfileError,
  );
});

test("rejects non-HTTPS repositories, duplicate identifiers, and identifier disorder", () => {
  const base = {
    repository: "https://github.com/example/sample-plugin",
    requirement: "required",
    enabled: true,
    bundle: { kind: "release", tag: "1.0.0" },
    files: { "manifest.json": digest, "main.js": digest },
    settings: { policy: "machine-local" },
  };
  for (const plugins of [
    [{ ...base, id: "sample-plugin", repository: "http://example.com/plugin" }],
    [
      { ...base, id: "sample-plugin" },
      { ...base, id: "sample-plugin" },
    ],
    [
      { ...base, id: "z-plugin" },
      { ...base, id: "a-plugin" },
    ],
  ]) {
    assert.throws(
      () =>
        parseProfile({
          format_version: 1,
          runtime: {
            minimum_obsidian: "1.0.0",
            checked_obsidian: "1.14.5",
            checked_installer: "1.14.5",
          },
          plugins,
        }),
      ProfileError,
    );
  }
});

test("rejects identifiers and settings paths that can escape their roots", () => {
  for (const candidate of [
    { id: "../../target", settings: { policy: "machine-local" } },
    {
      id: "sample-plugin",
      settings: { policy: "project-owned", source: "../outside.yml" },
    },
  ]) {
    assert.throws(
      () =>
        parseProfile({
          format_version: 1,
          runtime: {
            minimum_obsidian: "1.0.0",
            checked_obsidian: "1.14.5",
            checked_installer: "1.14.5",
          },
          plugins: [
            {
              ...candidate,
              repository: "https://github.com/example/sample-plugin",
              requirement: "required",
              enabled: true,
              bundle: { kind: "release", tag: "1.0.0" },
              files: { "manifest.json": digest, "main.js": digest },
            },
          ],
        }),
      ProfileError,
    );
  }
});

test("accepts only sorted, unique, unreserved mutable JSON file names", () => {
  const base = {
    id: "sample-plugin",
    repository: "https://github.com/example/sample-plugin",
    requirement: "required",
    enabled: true,
    bundle: { kind: "release", tag: "1.0.0" },
    files: { "manifest.json": digest, "main.js": digest },
    settings: { policy: "machine-local" },
  };
  for (const mutable_json_files of [
    ["second.json", "first.json"],
    ["state.json", "state.json"],
    ["data.json"],
    ["nested/state.json"],
    ["payload.js"],
    ["State.json"],
  ]) {
    assert.throws(
      () =>
        parseProfile({
          format_version: 1,
          runtime: {
            minimum_obsidian: "1.0.0",
            checked_obsidian: "1.14.5",
            checked_installer: "1.14.5",
          },
          plugins: [{ ...base, mutable_json_files }],
        }),
      ProfileError,
    );
  }
});

test("rejects an override absent from the canonical profile", () => {
  const profile = parseProfile({
    format_version: 1,
    runtime: {
      minimum_obsidian: "1.0.0",
      checked_obsidian: "1.14.5",
      checked_installer: "1.14.5",
    },
    plugins: [],
  });
  assert.throws(
    () => parseLocalOverrides({ undeclared: { path: "/tmp/plugin" } }, profile),
    ProfileError,
  );
});
