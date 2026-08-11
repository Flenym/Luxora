import { describe, expect, it } from "vitest";
import { AttachmentSchema, PatchCurrentUserSchema, SetProfileAvatarSchema, UserSchema } from "./index.js";

describe("current-user profile mutation contract", () => {
  it("accepts a trimmed display name, an empty bio, or both", () => {
    expect(PatchCurrentUserSchema.parse({ displayName: "  Егор Flenym  " })).toEqual({
      displayName: "Егор Flenym"
    });
    expect(PatchCurrentUserSchema.parse({ bio: "   " })).toEqual({ bio: "" });
    expect(PatchCurrentUserSchema.parse({ displayName: "Luxora", bio: "Beta-0.1" })).toEqual({
      displayName: "Luxora",
      bio: "Beta-0.1"
    });
  });

  it("rejects empty mutations, blank names, oversize values and unknown fields", () => {
    expect(PatchCurrentUserSchema.safeParse({}).success).toBe(false);
    expect(PatchCurrentUserSchema.safeParse({ displayName: "  " }).success).toBe(false);
    expect(PatchCurrentUserSchema.safeParse({ displayName: "x".repeat(81) }).success).toBe(false);
    expect(PatchCurrentUserSchema.safeParse({ bio: "x".repeat(501) }).success).toBe(false);
    expect(PatchCurrentUserSchema.safeParse({ displayName: "Luxora", avatarUrl: "https://example.test/a" }).success)
      .toBe(false);
  });

  it("accepts only an owned-attachment identifier at the avatar command boundary", () => {
    const attachmentId = "0198a32a-8b8b-7a12-9123-5da81cf8cfb0";
    expect(SetProfileAvatarSchema.parse({ attachmentId })).toEqual({ attachmentId });
    expect(SetProfileAvatarSchema.safeParse({ attachmentId: "not-an-id" }).success).toBe(false);
    expect(SetProfileAvatarSchema.safeParse({
      attachmentId,
      avatarUrl: "https://example.test/unowned.png"
    }).success).toBe(false);
  });

  it("carries a relative authenticated avatar path and server-verified derivative trust", () => {
    const id = "0198a32a-8b8b-7a12-9123-5da81cf8cfb0";
    expect(UserSchema.parse({
      id,
      username: "flenym",
      displayName: "Flenym",
      bio: "",
      avatarUrl: null,
      avatarPath: `/v1/attachments/${id}/content`,
      createdAt: "2026-08-11T06:00:00.000Z"
    }).avatarPath).toContain(id);
    expect(AttachmentSchema.parse({
      id,
      kind: "image",
      fileName: "profile-avatar.png",
      mimeType: "image/png",
      sizeBytes: 128,
      sha256: "a".repeat(64),
      downloadPath: `/v1/attachments/${id}/content`,
      safetyStatus: "reencoded",
      metadataTrust: "server_verified",
      metadata: { width: 512, height: 512 },
      createdAt: "2026-08-11T06:00:00.000Z"
    })).toMatchObject({ safetyStatus: "reencoded", metadataTrust: "server_verified" });
  });
});
