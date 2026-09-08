# Kiro Auto-Deactivation on Quota Exhaustion

## Overview

This document describes the automatic account deactivation feature implemented for the Kiro provider. When quota/credit limits are exhausted, the system automatically disables the connection to prevent further failed requests.

**Implementation Date**: June 9, 2026

**Status**: ✅ Fully Implemented and Tested

## Behavior

### Before (Previous Implementation)
- Quota exhaustion set `testStatus = "unavailable"` with temporary cooldown
- Connection remained `isActive = true`
- Would retry after cooldown period expired
- Connection visible in UI but temporarily unavailable

### After (Current Implementation)
- Quota exhaustion sets `isActive = false` (permanent until manual re-enable)
- Connection is disabled and won't be used for routing
- Connection hidden in UI by default (see Task 4 filtering)
- User must manually re-enable via "Activate" button

## Detected Error Patterns

All patterns are **case-insensitive**. The system matches any of these substrings in error messages:

### UI-Visible Quota Messages
- `"Insufficient Balance"`
- `"Quota Exhausted"`
- `"providers.No Credits"`
- `"You have reached the limit"`

### AWS CodeWhisperer / Kiro-Specific
- `"usage limit exceeded"`
- `"quota exceeded"`
- `"limit exceeded"`
- `"ThrottlingException"`

### Generic Provider Patterns
- `"insufficient_quota"`
- `"billing_hard_limit_reached"`
- `"exceeded your current quota"`
- `"credit_balance_too_low"`
- `"credits exhausted"`
- `"out of credits"`
- `"no credits"`
- `"payment required"`
- `"resource has been exhausted"`
- `"resource_exhausted"`
- `"check quota"`
- `"free tier exhausted"`
- `"reached the limit"`

## Implementation Details

### 1. Error Detection

**File**: `open-sse/services/accountFallback.ts` (lines 121-143)

```typescript
export const CREDITS_EXHAUSTED_SIGNALS = [
  "insufficient_quota",
  "billing_hard_limit_reached",
  "exceeded your current quota",
  "exceeded your current usage quota",
  "credit_balance_too_low",
  "your credit balance is too low",
  "credits exhausted",
  "quota exhausted",
  "out of credits",
  "no credits",
  "payment required",
  "resource has been exhausted",
  "resource_exhausted",
  "check quota",
  "free tier of the model has been exhausted",
  "reached the limit",
  "you have reached",
  // AWS CodeWhisperer / Kiro-specific patterns
  "usage limit exceeded",
  "quota exceeded",
  "limit exceeded",
  "throttlingexception",
  // UI-visible quota messages
  "insufficient balance",
];

export function isCreditsExhausted(errorText: string): boolean {
  const lower = String(errorText || "").toLowerCase();
  return CREDITS_EXHAUSTED_SIGNALS.some((sig) => lower.includes(sig));
}
```

### 2. Automatic Deactivation

**File**: `open-sse/handlers/chatCore.ts` (line 4717)

```typescript
} else {
  await updateProviderConnection(connectionId, {
    isActive: false,  // ← Automatically disable the connection
    testStatus: "credits_exhausted",
    lastErrorType: errorType,
    lastError: message,
    errorCode: statusCode,
  });
  console.warn(`[provider] Node ${connectionId} exhausted quota (${statusCode}) - account deactivated`);
}
```

### 3. Database State

When quota is exhausted, the following fields are updated in `provider_connections`:

| Field | Value | Purpose |
|-------|-------|---------|
| `is_active` | `0` (false) | Disables routing to this connection |
| `test_status` | `"credits_exhausted"` | Terminal status indicator |
| `last_error_type` | `"quota_exhausted"` | Error classification |
| `last_error` | Error message | Full error text for debugging |
| `error_code` | `429` (typically) | HTTP status code |
| `updated_at` | Current timestamp | Last modification time |

## Error Flow Diagram

```
Kiro API Request
  ↓
Receives 429 or quota error message
  ↓
chatCore.ts error handler
  ↓
checkFallbackError() → isCreditsExhausted(errorStr)
  ↓
Returns { creditsExhausted: true, reason: QUOTA_EXHAUSTED }
  ↓
chatCore.ts line 4717: updateProviderConnection()
  ↓
Database: is_active=0, test_status="credits_exhausted"
  ↓
Connection disabled (not used for routing)
  ↓
UI: Connection hidden by default (Task 4 filtering)
```

## Manual Re-activation

When a Kiro account has been topped up with credits, you can manually re-enable the connection:

### Via Dashboard UI

1. Navigate to `/dashboard/providers/kiro`
2. Toggle "Show Only Active" **OFF** to reveal disabled connections
3. Select the deactivated connection(s) using checkboxes
4. Click the **"Activate"** button in the bulk actions toolbar
5. Toggle "Show Only Active" **ON** to return to normal view

### Via API

```bash
curl -X PATCH http://localhost:20128/api/providers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "ids": ["kiro-connection-id"],
    "isActive": true
  }'
```

### Via Database (Emergency)

```sql
UPDATE provider_connections 
SET is_active = 1,
    test_status = 'active',
    last_error = NULL,
    last_error_type = NULL,
    error_code = NULL,
    updated_at = datetime('now')
WHERE id = 'kiro-connection-id';
```

## Testing

### Unit Tests

**File**: `tests/unit/kiro-auto-deactivate.test.ts` (3 tests)

```bash
node --import tsx/esm --test tests/unit/kiro-auto-deactivate.test.ts
```

**Coverage**:
- ✅ `isCreditsExhausted()` detects all Kiro quota patterns
- ✅ Database schema supports `isActive=false` with `credits_exhausted` status
- ✅ Code review verification that `chatCore.ts` sets `isActive: false`

**File**: `tests/unit/kiro-credit-exhaustion.test.ts` (7 tests)

```bash
node --import tsx/esm --test tests/unit/kiro-credit-exhaustion.test.ts
```

**Coverage**:
- ✅ Detects "Insufficient Balance"
- ✅ Detects "Quota Exhausted"
- ✅ Detects "providers.No Credits"
- ✅ Detects "You have reached the limit"
- ✅ Case-insensitive detection
- ✅ Detects AWS CodeWhisperer/Kiro patterns
- ✅ Does not false-positive on unrelated errors

### Run All Tests

```bash
node --import tsx/esm --test tests/unit/kiro-credit-exhaustion.test.ts tests/unit/kiro-auto-deactivate.test.ts
```

**Result**: ✅ 10/10 tests passing

## Related Features

- **Task 1**: [Default Rate Limit Protection](./kiro-rate-limit-protection.md#1-default-rate-limit-protection)
- **Task 3**: [Bulk Enable/Disable](./kiro-rate-limit-protection.md#3-bulk-enabledisable-connections)
- **Task 4**: [View Filtering](./kiro-view-filtering.md)
- **Toggle Switch**: [Show Only Active Control](./kiro-view-filtering.md#toggle-feature)

## Monitoring

### Check Deactivated Connections

```sql
SELECT id, name, email, last_error, last_error_type, error_code, updated_at
FROM provider_connections
WHERE provider = 'kiro' 
  AND is_active = 0 
  AND test_status = 'credits_exhausted'
ORDER BY updated_at DESC;
```

### Dashboard View

Navigate to `/dashboard/providers/kiro` and toggle "Show Only Active" OFF to see all connections including deactivated ones. Deactivated connections will show with a red "Disabled" badge and the status "Insufficient Balance / Quota Exhausted".

## FAQ

**Q: Will the connection automatically re-enable when credits are added?**  
A: No. The deactivation is permanent until manually re-enabled via the UI or API.

**Q: What happens to in-flight requests when a connection is deactivated?**  
A: In-flight requests may still complete. Subsequent requests will not route to the deactivated connection.

**Q: Can I see deactivated connections in the UI?**  
A: Yes. Toggle "Show Only Active" OFF on the Kiro provider page to reveal disabled connections.

**Q: Does this affect other providers?**  
A: No. This auto-deactivation logic only applies when `errorType === PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED` in chatCore.ts. Other providers follow their own quota handling logic.

**Q: What if I want temporary cooldown instead of permanent deactivation?**  
A: For per-model quota limits (not connection-wide exhaustion), the system uses model lockout instead of connection deactivation. See `open-sse/services/accountFallback.ts::lockModelIfPerModelQuota()`.
