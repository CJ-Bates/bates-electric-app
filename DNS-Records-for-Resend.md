# DNS Records Needed for bates-electric.com

**Purpose:** These records allow us to send inspection report emails from `inspections@bates-electric.com` using our email service (Resend). Without them, emails come from a generic address instead of the Bates Electric domain.

**Where to add them:** Cloudflare DNS for `bates-electric.com`

---

## Record 1 — DKIM (email authentication)

- **Type:** TXT
- **Name:** `resend._domainkey`
- **Value:**
```
p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC7ngDZpa8MrACQJwl+Gg6oLAVkjm6teC4vwcBgu/W4aXJ9zx7Sh+2lpHBkkXH+aXdU3YG5cGIwNASX7hK0AV1F8ORzlBwI99DVPR/tJANYSqVe8xz262h02rGWjcpnjze39zaZ37vKFyKaSCn3f6zwyfthguuWIA5/2UQY9nSmcwIDAQAB
```
- **TTL:** Auto
- **Proxy:** OFF (DNS only / gray cloud)

## Record 2 — SPF (MX record for sending subdomain)

- **Type:** MX
- **Name:** `send`
- **Mail server:** `feedback-smtp.us-east-1.amazonses.com`
- **Priority:** 10
- **TTL:** Auto
- **Proxy:** N/A (MX records can't be proxied)

## Record 3 — SPF (TXT record for sending subdomain)

- **Type:** TXT
- **Name:** `send`
- **Value:**
```
v=spf1 include:amazonses.com ~all
```
- **TTL:** Auto
- **Proxy:** OFF (DNS only / gray cloud)

## Record 4 — DMARC (email policy)

- **Type:** TXT
- **Name:** `_dmarc`
- **Value:**
```
v=DMARC1; p=quarantine; rua=mailto:fc42f145@mxtoolbox.dmarc-report.com; ruf=mailto:fc42f145@forensics.dmarc-report.com; fo=1; pct=100
```
- **TTL:** Auto
- **Proxy:** OFF (DNS only / gray cloud)

---

## How to Add in Cloudflare

1. Log in to Cloudflare and select the **bates-electric.com** domain
2. Go to **DNS** → **Records**
3. Click **Add record** for each of the 4 records above
4. For the **Name** field, enter just the subdomain part (e.g., `resend._domainkey`, not the full `resend._domainkey.bates-electric.com`)
5. Make sure the orange proxy cloud is **OFF** (gray cloud / DNS only) for all TXT records
6. After all 4 are added, let CJ know so we can click **Verify** in Resend

## After Verification

Once the records are added and verified in Resend, we'll update the app to send inspection reports from `inspections@bates-electric.com` — no further DNS changes needed.
