import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorMemoryStore, OperatorMemoryError } from "./operator-memory.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "awos-opmem-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(name: string, body: string) {
  writeFileSync(join(root, name), body, "utf8");
}

describe("OperatorMemoryStore.list", () => {
  it("returns empty list when root is missing", async () => {
    const store = new OperatorMemoryStore({ root: join(root, "absent") });
    expect(await store.list()).toEqual([]);
  });

  it("returns parsed entries sorted by key", async () => {
    write(
      "feedback-zeta.md",
      "---\nname: Z\ndescription: zee\ntype: feedback\n---\nbody-z",
    );
    write(
      "user-alpha.md",
      "---\nname: A\ndescription: alpha\ntype: user\n---\nbody-a",
    );
    const store = new OperatorMemoryStore({ root });
    const entries = await store.list();
    expect(entries.map((e) => e.key)).toEqual(["feedback-zeta", "user-alpha"]);
    expect(entries[0]).toMatchObject({ name: "Z", type: "feedback", description: "zee" });
    expect(entries[1]).toMatchObject({ name: "A", type: "user", description: "alpha" });
  });

  it("skips non-md files, hidden files, and subdirectories", async () => {
    write("note.md", "---\nname: keep\n---\nx");
    write("README.txt", "ignore");
    write(".hidden.md", "ignore");
    mkdirSync(join(root, "subdir"));
    const store = new OperatorMemoryStore({ root });
    const entries = await store.list();
    expect(entries.map((e) => e.key)).toEqual(["note"]);
  });

  it("handles files without frontmatter", async () => {
    write("plain.md", "no frontmatter here");
    const store = new OperatorMemoryStore({ root });
    const [entry] = await store.list();
    expect(entry.key).toBe("plain");
    expect(entry.name).toBeUndefined();
    expect(entry.bytes).toBe("no frontmatter here".length);
  });
});

describe("OperatorMemoryStore.read", () => {
  it("returns body and parsed frontmatter", async () => {
    write(
      "feedback-test.md",
      "---\nname: Test\ndescription: short\ntype: feedback\n---\nThe body here.",
    );
    const store = new OperatorMemoryStore({ root });
    const r = await store.read("feedback-test");
    expect(r.existed).toBe(true);
    expect(r.name).toBe("Test");
    expect(r.description).toBe("short");
    expect(r.type).toBe("feedback");
    expect(r.body).toBe("The body here.");
    expect(r.raw).toContain("---");
  });

  it("returns existed=false for missing key (does not throw)", async () => {
    const store = new OperatorMemoryStore({ root });
    const r = await store.read("nope");
    expect(r.existed).toBe(false);
    expect(r.body).toBe("");
  });

  it("rejects keys with .. (path traversal)", async () => {
    const store = new OperatorMemoryStore({ root });
    await expect(store.read("../etc/passwd")).rejects.toBeInstanceOf(OperatorMemoryError);
  });

  it("rejects keys with leading slash", async () => {
    const store = new OperatorMemoryStore({ root });
    await expect(store.read("/abs")).rejects.toBeInstanceOf(OperatorMemoryError);
  });

  it("rejects keys with illegal characters", async () => {
    const store = new OperatorMemoryStore({ root });
    await expect(store.read("bad key with spaces")).rejects.toBeInstanceOf(OperatorMemoryError);
    await expect(store.read("semi;colon")).rejects.toBeInstanceOf(OperatorMemoryError);
  });

  it("supports nested keys", async () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "page.md"), "---\nname: nested\n---\nbody", "utf8");
    const store = new OperatorMemoryStore({ root });
    const r = await store.read("sub/page");
    expect(r.existed).toBe(true);
    expect(r.body).toBe("body");
  });
});
