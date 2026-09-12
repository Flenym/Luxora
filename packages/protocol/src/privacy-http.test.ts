import { describe, expect, it } from "vitest";
import {
  PatchPrivacySettingsSchema,
  PrivacySettingsSchema,
  PrivacyVisibilitySchema
} from "./index.js";

describe("privacy visibility policies", () => {
  it("accepts the full visibility matrix", () => {
    expect(PrivacySettingsSchema.parse({
      usernameDiscoverable: true,
      messageRequests: "everyone",
      lastSeen: "contacts",
      profilePhoto: "nobody",
      forwards: "everyone",
      voiceMessages: "contacts",
      calls: "nobody"
    }).calls).toBe("nobody");
    expect(PrivacyVisibilitySchema.safeParse("friends").success).toBe(false);
  });

  it("requires at least one patch field and rejects unknown policies", () => {
    expect(PatchPrivacySettingsSchema.parse({ lastSeen: "nobody" })).toEqual({
      lastSeen: "nobody"
    });
    expect(PatchPrivacySettingsSchema.safeParse({}).success).toBe(false);
    expect(PatchPrivacySettingsSchema.safeParse({ profilePhoto: "everyone-except" }).success).toBe(false);
    expect(PatchPrivacySettingsSchema.safeParse({
      voiceMessages: "contacts",
      secretExtraField: true
    }).success).toBe(false);
  });
});
