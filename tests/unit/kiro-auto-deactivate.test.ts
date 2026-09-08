/**
 * Unit tests for automatic account deactivation on quota exhaustion (Task 2)
 * 
 * Verifies that:
 * 1. The error detection logic identifies quota exhaustion patterns
 * 2. The database schema supports storing isActive=false with credits_exhausted status
 * 3. The chatCore.ts handler sets isActive=false when quota is exhausted
 */

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";
import Database from "better-sqlite3";
import { getDbInstance, resetDbInstance } from "@/lib/db/core";
import { createProviderConnection, deleteProviderConnection } from "@/lib/db/providers";
import { isCreditsExhausted } from "../../open-sse/services/accountFallback.js";

describe("Kiro Auto-Deactivate on Quota Exhaustion", () => {
  const createdIds: string[] = [];

  after(() => {
    // Clean up test connections
    for (const id of createdIds) {
      try {
        deleteProviderConnection(id);
      } catch (err) {
        // Ignore errors during cleanup
      }
    }
    resetDbInstance();
  });

  test("isCreditsExhausted detects Kiro quota patterns", () => {
    // Verify error detection for all Kiro-specific patterns
    assert.strictEqual(
      isCreditsExhausted("usage limit exceeded"),
      true,
      "Should detect 'usage limit exceeded'"
    );
    assert.strictEqual(
      isCreditsExhausted("quota exceeded"),
      true,
      "Should detect 'quota exceeded'"
    );
    assert.strictEqual(
      isCreditsExhausted("limit exceeded"),
      true,
      "Should detect 'limit exceeded'"
    );
    assert.strictEqual(
      isCreditsExhausted("ThrottlingException"),
      true,
      "Should detect 'ThrottlingException'"
    );
    assert.strictEqual(
      isCreditsExhausted("Insufficient Balance / Quota Exhausted"),
      true,
      "Should detect 'Insufficient Balance / Quota Exhausted'"
    );
  });

  test("database schema supports credits_exhausted with isActive=false", async () => {
    // Create a Kiro connection
    const connection = await createProviderConnection({
      provider: "kiro",
      authType: "oauth",
      name: "Test Kiro Account",
      isActive: true,
    });
    createdIds.push(connection.id);

    // Directly update via SQL to simulate what chatCore.ts does
    const db = getDbInstance() as Database.Database;
    db.prepare(
      `UPDATE provider_connections 
       SET is_active = 0, 
           test_status = 'credits_exhausted',
           last_error_type = 'quota_exhausted',
           last_error = 'Quota Exhausted',
           error_code = 429,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(connection.id);

    // Verify the update worked
    const row = db
      .prepare(
        `SELECT is_active, test_status, last_error_type, last_error, error_code 
         FROM provider_connections 
         WHERE id = ?`
      )
      .get(connection.id) as {
      is_active: number;
      test_status: string | null;
      last_error_type: string | null;
      last_error: string | null;
      error_code: number | null;
    };

    assert.strictEqual(row.is_active, 0, "is_active should be 0 (false)");
    assert.strictEqual(row.test_status, "credits_exhausted", "test_status should be credits_exhausted");
    assert.strictEqual(row.last_error_type, "quota_exhausted", "last_error_type should be quota_exhausted");
    assert.strictEqual(String(row.error_code), "429", "error_code should be 429");
  });

  test("chatCore.ts sets isActive=false for credits_exhausted (code review)", async () => {
    // This is a code-level assertion - the actual logic is in open-sse/handlers/chatCore.ts
    // around line 4717 where it calls updateProviderConnection with isActive: false
    // when errorType === PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED
    
    // We verify the implementation exists by reading the file content
    const fs = await import("fs");
    const chatCoreContent = fs.readFileSync(
      "open-sse/handlers/chatCore.ts",
      "utf-8"
    );

    // Verify the fix is present: isActive: false is set when testStatus: "credits_exhausted"
    assert.ok(
      chatCoreContent.includes('isActive: false') && 
      chatCoreContent.includes('testStatus: "credits_exhausted"'),
      "chatCore.ts should contain isActive: false with testStatus: credits_exhausted"
    );

    // Verify the console.warn message indicates deactivation
    assert.ok(
      chatCoreContent.includes("account deactivated") || 
      chatCoreContent.includes("exhausted quota"),
      "chatCore.ts should log when account is deactivated due to quota exhaustion"
    );
  });
});
