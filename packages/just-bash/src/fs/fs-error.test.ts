import { describe, expect, it } from "vitest";
import { FsError, fsErrorCode, isFsErrorCode, toFsError } from "./fs-error.js";

describe("FsError", () => {
  it("renders the CODE: message display form from an unprefixed message", () => {
    const e = new FsError("ENOENT", "no such file or directory");
    expect(e.message).toBe("ENOENT: no such file or directory");
    expect(e.code).toBe("ENOENT");
    expect(e.bareMessage).toBe("no such file or directory");
    // name stays "Error": String(err) is display surface and node fs
    // errors render identically.
    expect(String(e)).toBe("Error: ENOENT: no such file or directory");
    expect(e).toBeInstanceOf(Error);
  });

  it("does not double-prefix a message that already carries the code", () => {
    const e = new FsError("EACCES", "EACCES: permission denied");
    expect(e.message).toBe("EACCES: permission denied");
    expect(e.bareMessage).toBe("permission denied");
  });

  it("bareMessage strips a colon-only prefix as well as colon-space", () => {
    expect(new FsError("EIO", "EIO:foo").bareMessage).toBe("foo");
    expect(new FsError("EIO", "EIO: foo").bareMessage).toBe("foo");
    // A message that starts with the code but is not a prefix is kept.
    expect(new FsError("EIO", "EIOther").message).toBe("EIO: EIOther");
    expect(new FsError("EIO", "EIOther").bareMessage).toBe("EIOther");
  });

  it("rejects an empty code at construction", () => {
    expect(() => new FsError("", "x")).toThrow(
      "FsError: code must be a non-empty errno name",
    );
  });
});

describe("fsErrorCode / isFsErrorCode", () => {
  it("reads FsError and node-style codes", () => {
    expect(fsErrorCode(new FsError("ENOTDIR", "x"))).toBe("ENOTDIR");
    expect(fsErrorCode(Object.assign(new Error("y"), { code: "EEXIST" }))).toBe(
      "EEXIST",
    );
    expect(isFsErrorCode(new FsError("EBUSY", "x"), "EBUSY")).toBe(true);
    expect(isFsErrorCode(new FsError("EBUSY", "x"), "ENOENT")).toBe(false);
  });

  it("returns undefined for codeless, non-string-code, and empty-code values", () => {
    expect(fsErrorCode(new Error("plain"))).toBeUndefined();
    expect(fsErrorCode("ENOENT: string is not an object")).toBeUndefined();
    expect(fsErrorCode(null)).toBeUndefined();
    expect(fsErrorCode(undefined)).toBeUndefined();
    expect(fsErrorCode({ code: 44 })).toBeUndefined();
    expect(fsErrorCode({ code: "" })).toBeUndefined();
  });

  it("reads an inherited code through the prototype chain", () => {
    const proto = { code: "ELOOP" };
    const err = Object.assign(Object.create(proto), new Error("z"));
    expect(fsErrorCode(err)).toBe("ELOOP");
  });
});

describe("toFsError", () => {
  it("passes structured codes through with canonical rendering", () => {
    const nodeStyle = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
    });
    const e = toFsError(nodeStyle);
    expect(e).toBeInstanceOf(FsError);
    expect(e.code).toBe("ENOENT");
    expect(e.message).toBe("ENOENT: no such file");
  });

  it("is idempotent on FsError input", () => {
    const once = toFsError(new FsError("EACCES", "denied"));
    const twice = toFsError(once);
    expect(twice.message).toBe("EACCES: denied");
    expect(twice.code).toBe("EACCES");
  });

  it("coerces codeless values to the fallback with the message preserved", () => {
    const e = toFsError(new Error("mystery"));
    expect(e.code).toBe("EIO");
    expect(e.message).toBe("EIO: mystery");
    expect(toFsError("string failure", "EPERM").code).toBe("EPERM");
    expect(toFsError(null).message).toBe("EIO: unknown error");
  });

  it("strips only a redundant prefix for the SAME code", () => {
    // A message carrying a DIFFERENT code's prefix is prose, kept as-is.
    const e = toFsError(
      Object.assign(new Error("EACCES: wrapped differently"), {
        code: "ENOENT",
      }),
    );
    expect(e.message).toBe("ENOENT: EACCES: wrapped differently");
    expect(e.code).toBe("ENOENT");
  });
});
