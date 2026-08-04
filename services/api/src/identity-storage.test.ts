import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { LuxoraApp } from "./app.js";
import { buildApp } from "./app.js";
import { testConfig } from "./test-helpers.js";

describe("IA-1 encrypted persistence and audit durability", () => {
  it("encrypts private payloads and rejects audit mutation or deletion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "luxora-ia1-storage-"));
    const databasePath = join(directory, "luxora.sqlite");
    const key = Buffer.alloc(32, 19).toString("base64url");
    let app: LuxoraApp | undefined;

    try {
      app = await buildApp({
        config: testConfig({
          databasePath,
          dataEncryptionKeys: { test: key },
          activeDataEncryptionKeyId: "test",
          storageLocalPath: join(directory, "objects"),
          uploadStagingPath: join(directory, "uploads")
        }),
        logger: false
      });

      const register = async (username: string) => {
        const response = await app!.inject({
          method: "POST",
          url: "/v1/auth/register",
          payload: {
            username,
            displayName: username,
            password: "correct horse battery staple"
          }
        });
        return {
          id: response.json().user.id as string,
          accessToken: response.json().tokens.accessToken as string
        };
      };
      const alice = await register("cipher_alice");
      const bob = await register("cipher_bob");
      const aliceAuth = { authorization: `Bearer ${alice.accessToken}` };
      const bobAuth = { authorization: `Bearer ${bob.accessToken}` };
      const requestText = "Encrypted request https://secret.example/private-path";

      const created = await app.inject({
        method: "POST",
        url: "/v1/message-requests",
        headers: aliceAuth,
        payload: {
          recipientUserId: bob.id,
          body: requestText,
          clientNonce: randomUUID()
        }
      });
      expect(created.statusCode).toBe(201);
      const accepted = await app.inject({
        method: "POST",
        url: `/v1/message-requests/${created.json().request.id as string}/accept`,
        headers: bobAuth
      });
      expect(accepted.statusCode).toBe(200);
      const evidence = await app.inject({
        method: "POST",
        url: `/v1/chats/${accepted.json().chat.id as string}/messages`,
        headers: bobAuth,
        payload: { body: "Selected encrypted evidence", clientNonce: randomUUID() }
      });
      const report = await app.inject({
        method: "POST",
        url: "/v1/safety/reports",
        headers: aliceAuth,
        payload: {
          subjectAccountId: bob.id,
          category: "harassment",
          evidence: [{ type: "message", messageId: evidence.json().message.id as string }],
          comment: "Encrypted reporter-only comment",
          alsoBlock: true,
          clientNonce: randomUUID()
        }
      });
      expect(report.statusCode).toBe(201);

      const raw = new Database(databasePath);
      try {
        const requestRow = raw.prepare(`
          SELECT body_ciphertext, link_url_ciphertext,
            sender_profile_snapshot_ciphertext, recipient_profile_snapshot_ciphertext
          FROM message_requests LIMIT 1
        `).get() as Record<string, string>;
        for (const stored of Object.values(requestRow)) {
          expect(stored.startsWith("luxora:v1.")).toBe(true);
          expect(stored).not.toContain("secret.example");
          expect(stored).not.toContain("cipher_");
        }

        const blockRow = raw.prepare(`
          SELECT profile_snapshot_ciphertext FROM account_blocks LIMIT 1
        `).get() as { profile_snapshot_ciphertext: string };
        expect(blockRow.profile_snapshot_ciphertext.startsWith("luxora:v1.")).toBe(true);
        expect(blockRow.profile_snapshot_ciphertext).not.toContain("cipher_bob");

        const reportRow = raw.prepare(`
          SELECT evidence_ciphertext, comment_ciphertext FROM safety_reports LIMIT 1
        `).get() as { evidence_ciphertext: string; comment_ciphertext: string };
        expect(reportRow.evidence_ciphertext.startsWith("luxora:v1.")).toBe(true);
        expect(reportRow.comment_ciphertext.startsWith("luxora:v1.")).toBe(true);
        expect(reportRow.evidence_ciphertext).not.toContain("Selected encrypted evidence");
        expect(reportRow.comment_ciphertext).not.toContain("reporter-only");

        const eventRows = raw.prepare("SELECT event_json FROM realtime_events").all() as Array<{ event_json: string }>;
        expect(eventRows.length).toBeGreaterThan(0);
        expect(eventRows.every(({ event_json }) => event_json.startsWith("luxora:v1."))).toBe(true);
        expect(eventRows.some(({ event_json }) => event_json.includes("relationship.block"))).toBe(false);

        const auditCount = (raw.prepare("SELECT count(*) AS count FROM identity_audit_events").get() as {
          count: number;
        }).count;
        expect(auditCount).toBeGreaterThanOrEqual(4);
        expect(() => raw.prepare("UPDATE identity_audit_events SET outcome = 'succeeded'").run())
          .toThrow(/append-only/u);
        expect(() => raw.prepare("DELETE FROM identity_audit_events").run())
          .toThrow(/append-only/u);
        expect((raw.prepare("SELECT count(*) AS count FROM identity_audit_events").get() as {
          count: number;
        }).count).toBe(auditCount);
      } finally {
        raw.close();
      }
    } finally {
      await app?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
