import { describe, expect, test } from "bun:test";
import { deriveUserId } from "../src/core/tags";

describe("deriveUserId", () => {
  test("returns userEmail when present", () => {
    const result = deriveUserId({
      userEmail: "user@example.com",
      userName: "user",
    });
    expect(result).toBe("user@example.com");
  });

  test("returns userName when userEmail is null", () => {
    const result = deriveUserId({
      userEmail: null,
      userName: "user",
    });
    expect(result).toBe("user");
  });

  test("returns 'default' when both userEmail and userName are null", () => {
    const result = deriveUserId({
      userEmail: null,
      userName: null,
    });
    expect(result).toBe("default");
  });

  test("treats empty string as falsy and falls back to userName", () => {
    const result = deriveUserId({
      userEmail: "",
      userName: "user",
    });
    expect(result).toBe("user");
  });

  test("returns 'default' when both userEmail and userName are undefined", () => {
    const result = deriveUserId({
      userEmail: undefined,
      userName: undefined,
    });
    expect(result).toBe("default");
  });
});
