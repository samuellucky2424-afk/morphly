# Morphly Credit-Based Billing System

## Overview

This document describes the credit-based billing system for Morphly, which replaces the previous Naira-based wallet system with a more flexible credit architecture.

## Architecture

### Credit System

- **2 credits per second** of stream time
- Credits are purchased in packages with USD base pricing
- Dynamic USD → NGN conversion via Paystack

### Credit Plans

| Plan | Credits | USD Price | Est. Time |
|------|---------|-----------|-----------|
| Starter | 500 | $10 | ~4m 10s |
| Basic | 1,000 | $20 | ~8m 20s |
| Pro | 2,000 | $40 | ~16m 40s |
| Enterprise | 5,000 | $100 | ~41m 40s |

## API Endpoints

### `GET /api/rate`
Returns the current USD → NGN exchange rate (cached for 1 hour).

**Response:**
```json
{
  "rate": 1500,
  "cached": true,
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

### `GET /api/wallet?userId=<uuid>`
Returns user's credits and transaction history.

**Response:**
```json
{
  "credits": 1000,
  "transactions": [...]
}
```

### `POST /api/start-session`
Starts a new streaming session.

**Body:**
```json
{
  "userId": "<uuid>"
}
```

**Response:**
```json
{
  "allowed": true,
  "sessionId": "<uuid>",
  "credits": 1000,
  "maxSeconds": 500,
  "token": "<api_key>"
}
```

### `POST /api/end-session`
Ends the active streaming session and deducts credits.

**Body:**
```json
{
  "userId": "<uuid>"
}
```

**Response:**
```json
{
  "success": true,
  "creditsDeducted": 100,
  "remainingCredits": 900
}
```

### `GET /api/session-status?userId=<uuid>`
Returns current session status and remaining credits.

**Response:**
```json
{
  "credits": 900,
  "secondsUsed": 50,
  "creditsUsed": 100,
  "remainingCredits": 900,
  "shouldStop": false
}
```

### `POST /api/verify-payment`
Verifies Paystack payment and adds credits.

**Body:**
```json
{
  "reference": "<paystack_ref>",
  "userId": "<uuid>",
  "credits": 1000,
  "priceUSD": 20
}
```

**Response:**
```json
{
  "status": "success",
  "message": "Payment verification successful",
  "creditsAdded": 1000,
  "newCredits": 2000
}
```

## Database Schema

See `schema.sql` for the complete database schema including:

- `users` - User accounts
- `wallets` - User credit balances
- `transactions` - Credit purchase and usage history
- `sessions` - Streaming session records
- `plans` - Available credit packages
- `subscriptions` - Purchase records
- `exchange_rates` - Currency conversion rates

## Security

### Row Level Security (RLS)

All tables have RLS enabled with policies that ensure:

- Users can only access their own data
- Service role (backend) bypasses RLS for admin operations

### Functions

- `get_user_credits(user_id)` - Get user's credit balance
- `deduct_credits(user_id, amount)` - Deduct credits atomically
- `add_credits(user_id, amount, ...)` - Add credits with transaction logging

## Frontend Integration

### AppContext

The `AppContext` provides:

- `credits` - Current credit balance
- `addCredits(amount)` - Add credits locally
- `deductCredits(amount)` - Deduct credits locally
- `setCredits(value)` - Set credits directly

### Subscription Page

Displays credit packages with:
- Credits amount
- Estimated stream time
- USD price
- NGN price (converted via `/api/rate`)

## Migration from Balance System

The previous system used Naira-based balance (e.g., ₦69.2/second). The new system:

1. Uses credits instead of monetary balance
2. Deducts 2 credits/second
3. Tracks both credits and transaction amounts for auditing
4. Supports USD-based pricing with dynamic NGN conversion
