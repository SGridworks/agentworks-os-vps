# Support Bundle

When you contact sgridworks support, they may ask for a bundle of diagnostic information.

## CLI bundle

On v0.1.9, start with the built-in bundle:

```bash
agentworks support-bundle agentworks-support-$(date +%Y%m%d-%H%M%S).tar.gz
```

Review the archive before sending it. Redact secrets and customer data as described below.

## What to collect

If the CLI command fails, collect these manually on the machine running AgentWorks OS and save the output:

### Service status and versions

```
agentworks status > service-status.txt
docker compose version > compose-version.txt
docker --version > docker-version.txt
```

### Container logs (past 24 hours)

```
agentworks logs > container-logs.txt
```

To include logs from a specific service, add the service name:

```
agentworks logs agentos-d > agentos-d-logs.txt
agentworks logs scanner-worker > scanner-logs.txt
```

### Scanner findings

```
curl -s http://localhost:7710/api/scanner/findings > scanner-findings.json
```

### Policy packs list

```
curl -s http://localhost:7710/api/policy/packs > policy-packs.json
```

### System info

```
df -h > disk-space.txt
docker info > docker-info.txt
```

## Redaction

Before sending, manually redact the following from text files:

**Always redact:**
- LLM API keys and credentials
- Customer vault content
- Contact PII (names, phone numbers, email addresses)
- Admin passwords and session tokens

**Anonymize:**
- Actor labels and IDs → replace with `actor_N`
- Tenant/company names → replace with `tenant_N`

**Never include:**
- Raw rule pack YAML files — send the metadata summary instead
- `~/.agentworks/config/.env`
- `~/.agentworks/config/secrets.json`

## Sending to sgridworks support

1. Put all the output files in one directory
2. Create a tar.gz archive:
   ```
   tar -czf support-bundle.tar.gz *.txt *.json
   ```
3. Attach it to a support ticket at sgridworks.com/support, or use the secure upload link in your confirmation email

Do not email the bundle directly. Use the secure upload mechanism.

## What to include in your support request

The bundle covers the technical picture. Include in your support ticket:
- What you were trying to do when the issue occurred
- When the issue started (time, date, timezone)
- Any error messages you saw (from error-messages.md if listed, or verbatim)
- Steps to reproduce if known
